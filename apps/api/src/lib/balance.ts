/**
 * Prepaid balances (SPEC 8.5): an accounting entry in D1, with the funds in the treasury. Amounts are micro-USD, which
 * are USDG's base units. A run or a question paid from a balance is debited in the same transaction that starts it, and
 * what could not be delivered goes back. Every change writes a line in `balance_entries`.
 */
import type { JobSpec, RewindInput, TopUp } from "@hyvo/schema";
import { getAddress } from "viem";
import { iso, isoOrNull } from "./clock";
import type { Config } from "./config";
import { ApiError } from "./errors";
import { holderTerms } from "./holder";
import { newId, newRunId, randomHex } from "./ids";
import { findJob, insertJobStatement, type JobRow } from "./jobs";
import { readyProfile } from "./clones";
import { buildSpec, checkDailyCap, checkSize, jobTimeoutFor, quoteRun, tokenAmount } from "./pricing";
import { checkQuestion } from "./questions";

const MICROS_PER_USD = 1_000_000;

export function toMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function toUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

export interface TopUpRow {
  order_id: string;
  address: string;
  token: string;
  amount: string;
  status: "quoted" | "paid";
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  payment_id: string | null;
  credited_micros: number | null;
}

export type BalanceReason = "topup" | "run" | "run_failed" | "ask" | "ask_returned";

export async function balanceOf(db: D1Database, address: string): Promise<number> {
  const row = await db
    .prepare("SELECT amount_micros FROM balances WHERE address = ?")
    .bind(address.toLowerCase())
    .first<{ amount_micros: number }>();
  return row?.amount_micros ?? 0;
}

interface Change {
  address: string;
  micros: number;
  reason: BalanceReason;
  runId?: string | null;
  orderId?: string | null;
  now: number;
  /** Makes the change conditional on an earlier statement of the same batch. */
  only?: { where: string; args: unknown[] };
}

function entryStatement(db: D1Database, delta: number, c: Change): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO balance_entries (id, address, delta_micros, reason, run_id, order_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? ${c.only ? `WHERE ${c.only.where}` : ""}`,
    )
    .bind(newId("be"), c.address, delta, c.reason, c.runId ?? null, c.orderId ?? null, c.now, ...(c.only?.args ?? []));
}

/** Add to a balance, and write its line. */
export function creditStatements(db: D1Database, c: Change): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO balances (address, amount_micros)
         SELECT ?, ? WHERE ${c.only?.where ?? "1"}
         ON CONFLICT(address) DO UPDATE SET amount_micros = amount_micros + excluded.amount_micros`,
      )
      .bind(c.address, c.micros, ...(c.only?.args ?? [])),
    entryStatement(db, c.micros, c),
  ];
}

export interface PrepaidRequest {
  scenario: Parameters<typeof buildSpec>[1]["scenario"];
  agents: number;
  rounds: number;
  mix?: Parameters<typeof buildSpec>[1]["mix"];
  question?: Parameters<typeof buildSpec>[1]["question"];
  listed?: boolean | undefined;
  requestId?: string | undefined;
  clone?: true | undefined;
  rewind?: RewindInput | undefined;
}

export interface PrepaidRun {
  runId: string;
  job: JobRow;
  chargedUsd: number;
  /** False when `requestId` found the run an earlier call started. */
  created: boolean;
}

/**
 * Start a run paid from the wallet's balance. The job is written only if the balance covers it, and the debit and its
 * line only if the job was written, all in one transaction, so a balance cannot pay for two runs at once.
 */
export async function startPrepaidRun(
  db: D1Database,
  cfg: Config,
  account: string,
  request: PrepaidRequest,
  now: number,
): Promise<PrepaidRun> {
  const address = account.toLowerCase();
  const earlier = await findByRequest(db, address, request.requestId);
  if (earlier) return earlier;
  checkSize(cfg, request);
  checkQuestion(cfg, request.question, now);
  const { discountBps, priority } = await holderTerms(db, cfg, account, now);
  const quote = quoteRun(cfg, request, discountBps);
  checkDailyCap(cfg, quote);
  const spec: JobSpec = buildSpec(cfg, request, quote);
  if (request.clone) {
    if (!cfg.features.clone) throw new ApiError(503, "clones_closed", "clones are not open yet");
    spec.clone = await readyProfile(db, address);
  }
  if (request.rewind) spec.rewind = request.rewind;
  const micros = toMicros(quote.priceUsd);
  const runId = newRunId(now * 1000);
  const queued = await chargeAndQueue(
    db,
    insertJobStatement(
      db,
      {
        runId,
        orderId: null,
        address,
        source: "balance",
        spec,
        // A clone's run is the wallet's own, and a rewind names a real token (docs/OPEN_ITEMS.md item 23).
        listed: request.listed !== false && !request.clone && !request.rewind,
        priority,
        timeoutS: jobTimeoutFor(cfg, request),
        chargedMicros: micros,
        requestId: request.requestId ?? null,
      },
      now,
      { where: "(SELECT amount_micros FROM balances WHERE address = ?) >= ?", args: [address, micros] },
    ),
    { address, runId, micros, now },
  );
  if (!queued) {
    // The other call of a retry may have won between the first look and this batch.
    const raced = await findByRequest(db, address, request.requestId);
    if (raced) return raced;
    const have = toUsd(await balanceOf(db, address));
    throw new ApiError(402, "insufficient_balance", `this run costs $${quote.priceUsd.toFixed(2)} and the balance is $${have.toFixed(2)}; top up first`);
  }
  return { runId, job: (await findJob(db, runId))!, chargedUsd: quote.priceUsd, created: true };
}

/**
 * A job statement that only inserts when the balance covers it, then the debit and its line only if it did, in one transaction. False
 * when the job was not written.
 */
export async function chargeAndQueue(
  db: D1Database,
  insert: D1PreparedStatement,
  c: { address: string; runId: string; micros: number; now: number },
): Promise<boolean> {
  const written = { where: "EXISTS (SELECT 1 FROM jobs WHERE run_id = ?)", args: [c.runId] };
  const [inserted] = await db.batch([
    insert,
    db.prepare(`UPDATE balances SET amount_micros = amount_micros - ? WHERE address = ? AND ${written.where}`).bind(c.micros, c.address, ...written.args),
    entryStatement(db, -c.micros, { address: c.address, micros: c.micros, reason: "run", runId: c.runId, now: c.now, only: written }),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

async function findByRequest(db: D1Database, address: string, requestId: string | undefined): Promise<PrepaidRun | null> {
  if (!requestId) return null;
  const job = await db.prepare("SELECT * FROM jobs WHERE address = ? AND request_id = ?").bind(address, requestId).first<JobRow>();
  return job ? { runId: job.run_id, job, chargedUsd: toUsd(job.charged_micros ?? 0), created: false } : null;
}

/** Take the price of one question; false when the balance does not cover it. */
export async function debitAsk(db: D1Database, account: string, micros: number, runId: string, now: number): Promise<boolean> {
  const address = account.toLowerCase();
  const id = newId("be");
  const [debit] = await db.batch([
    db
      .prepare("UPDATE balances SET amount_micros = amount_micros - ? WHERE address = ? AND amount_micros >= ?")
      .bind(micros, address, micros),
    db
      .prepare(
        `INSERT INTO balance_entries (id, address, delta_micros, reason, run_id, order_id, created_at)
         SELECT ?, ?, ?, 'ask', ?, NULL, ? WHERE changes() > 0`,
      )
      .bind(id, address, -micros, runId, now),
  ]);
  return (debit?.meta.changes ?? 0) > 0;
}

/** Give back the price of a question that could not be answered. */
export async function returnAsk(db: D1Database, account: string, micros: number, runId: string, now: number): Promise<void> {
  await db.batch(creditStatements(db, { address: account.toLowerCase(), micros, reason: "ask_returned", runId, now }));
}

// --- top-ups ---------------------------------------------------------------------------------

export async function findTopUp(db: D1Database, orderId: string): Promise<TopUpRow | null> {
  return db.prepare("SELECT * FROM topups WHERE order_id = ?").bind(orderId.toLowerCase()).first<TopUpRow>();
}

export async function createTopUp(db: D1Database, cfg: Config, account: string, amountUsd: number, now: number): Promise<TopUpRow> {
  const usdg = cfg.usdg;
  if (!cfg.features.payments || !usdg || !cfg.router) {
    throw new ApiError(503, "payments_disabled", "payments are not configured on this API");
  }
  const { topUpMinUsd, topUpMaxUsd } = cfg.balance;
  if (amountUsd < topUpMinUsd || amountUsd > topUpMaxUsd) {
    throw new ApiError(400, "bad_request", `a top-up must be from $${topUpMinUsd} to $${topUpMaxUsd}`);
  }
  const orderId = randomHex(32);
  await db
    .prepare(
      `INSERT INTO topups (order_id, address, token, amount, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'quoted', ?, ?)`,
    )
    .bind(orderId, account.toLowerCase(), usdg.address.toLowerCase(), tokenAmount(usdg, amountUsd).toString(), now, now + cfg.pricing.quoteTtlS)
    .run();
  return (await findTopUp(db, orderId))!;
}

export function topUpView(cfg: Config, row: TopUpRow, now: number): TopUp {
  const token = cfg.usdg && cfg.usdg.address.toLowerCase() === row.token ? cfg.usdg : null;
  const decimals = token?.decimals ?? 18;
  return {
    orderId: row.order_id as `0x${string}`,
    status: row.status === "paid" ? "paid" : now > row.expires_at ? "expired" : "quoted",
    address: getAddress(row.address),
    token: { address: getAddress(row.token), symbol: token?.symbol ?? "TOKEN", decimals },
    amount: row.amount,
    amountUsd: Number(row.amount) / 10 ** decimals,
    creditedUsd: row.credited_micros === null ? null : toUsd(row.credited_micros),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    paidAt: isoOrNull(row.paid_at),
    chainId: cfg.chainId,
    paymentRouter: cfg.router ?? "0x0000000000000000000000000000000000000000",
  };
}
