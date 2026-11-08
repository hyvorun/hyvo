/**
 * Payment detection (SPEC 8.3): `PaymentRouter.Paid` events are matched to orders by orderId,
 * token, amount and expiry. The cron scans new blocks every minute; a user can also submit the
 * transaction hash for an immediate check. Both paths record each event once (`payments.id` is
 * `<txHash>:<logIndex>`). A matching payment marks the order paid and queues its run in the same
 * D1 transaction; a matching top-up credits a balance the same way. Anything that cannot pay its order
 * gets a refund record: refunds are sent by hand from the treasury (docs/RUNBOOK.md).
 */
import { jobTimeoutFor } from "./pricing";
import type { JobSpec } from "@hyvo/schema";
import type { Hex } from "viem";
import { creditStatements, findTopUp, toMicros, type TopUpRow } from "./balance";
import { chainFor, type PaidLog } from "./chain";
import type { Config } from "./config";
import { getKv, setKv } from "./db";
import { newId, newRunId } from "./ids";
import { insertJobStatement } from "./jobs";

/** A payment that lands this long after its quote expired still pays it (wallet delays). */
export const PAYMENT_GRACE_S = 300;
export const SCAN_CURSOR_KEY = "payments.next_block";

export interface OrderRow {
  order_id: string;
  address: string;
  spec_json: string;
  title: string;
  listed: number;
  token: string;
  amount: string;
  price_usd: number;
  estimated_cost_usd: number;
  discount_bps: number;
  priority: number;
  status: "quoted" | "paid";
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  payment_id: string | null;
  run_id: string | null;
}

export type PaymentOutcome = "paid" | "duplicate" | "unmatched";

export async function findOrder(db: D1Database, orderId: string): Promise<OrderRow | null> {
  return db.prepare("SELECT * FROM orders WHERE order_id = ?").bind(orderId.toLowerCase()).first<OrderRow>();
}

/**
 * Record one Paid event and settle its order, in one D1 transaction: a failure leaves nothing
 * behind and the event is settled on the next try. Idempotent: `payments.id` admits an event once,
 * the order update admits one run, and a job or refund is written only once.
 */
export async function recordPayment(
  db: D1Database,
  cfg: Config,
  log: PaidLog,
  now: number,
): Promise<PaymentOutcome> {
  const id = `${log.txHash.toLowerCase()}:${log.logIndex}`;
  const orderId = log.orderId.toLowerCase();
  if (await db.prepare("SELECT 1 FROM payments WHERE id = ?").bind(id).first()) return "duplicate";

  const order = await findOrder(db, orderId);
  if (!order) {
    const topUp = await findTopUp(db, orderId);
    if (topUp) return settleTopUp(db, cfg, topUp, id, log, now);
  }
  const problem = mismatch(order, log);
  if (problem || !order) {
    const [inserted] = await db.batch([
      paymentStatement(db, id, orderId, log, false, problem, now),
      refundStatement(db, "payment_unmatched", { orderId, paymentId: id, log, amount: log.amount, now }),
    ]);
    return inserted?.meta.changes === 0 ? "duplicate" : "unmatched";
  }

  const runId = newRunId(now * 1000);
  const spec = JSON.parse(order.spec_json) as JobSpec;
  const statements = [
    paymentStatement(db, id, orderId, log, true, null, now),
    db
      .prepare(
        "UPDATE orders SET status = 'paid', paid_at = ?, payment_id = ?, run_id = ? WHERE order_id = ? AND status = 'quoted'",
      )
      .bind(Number(log.timestamp), id, runId, orderId),
    insertJobStatement(
      db,
      {
        runId,
        orderId,
        address: order.address,
        source: "paid",
        spec,
        listed: order.listed === 1,
        priority: order.priority,
        timeoutS: jobTimeoutFor(cfg, spec),
      },
      now,
    ),
  ];
  const excess = log.amount - BigInt(order.amount);
  if (excess > 0n) statements.push(refundStatement(db, "overpaid", { orderId, paymentId: id, log, amount: excess, now }));
  const [inserted] = await db.batch(statements);
  return inserted?.meta.changes === 0 ? "duplicate" : "paid";
}

/**
 * A top-up credits what arrived, whatever was asked for, and whenever: no price can have changed, so nothing about a late or
 * a different amount calls for sending money back and paying gas twice. Only another token cannot be credited.
 */
async function settleTopUp(
  db: D1Database,
  cfg: Config,
  topUp: TopUpRow,
  id: string,
  log: PaidLog,
  now: number,
): Promise<PaymentOutcome> {
  const orderId = topUp.order_id;
  const token = cfg.usdg;
  const known = token && token.address.toLowerCase() === topUp.token;
  const problem =
    topUp.status === "paid"
      ? "the top-up was already paid"
      : !known || log.token.toLowerCase() !== topUp.token
        ? "paid with another token than quoted"
        : null;
  if (problem || !known) {
    const [inserted] = await db.batch([
      paymentStatement(db, id, orderId, log, false, problem, now),
      refundStatement(db, "payment_unmatched", { orderId, paymentId: id, log, amount: log.amount, now }),
    ]);
    return inserted?.meta.changes === 0 ? "duplicate" : "unmatched";
  }
  const micros = toMicros(Number(log.amount) / 10 ** token.decimals);
  const [inserted] = await db.batch([
    paymentStatement(db, id, orderId, log, true, null, now),
    db
      .prepare(
        "UPDATE topups SET status = 'paid', paid_at = ?, payment_id = ?, credited_micros = ? WHERE order_id = ? AND status = 'quoted'",
      )
      .bind(Number(log.timestamp), id, micros, orderId),
    ...creditStatements(db, {
      address: topUp.address,
      micros,
      reason: "topup",
      orderId,
      now,
      only: { where: "EXISTS (SELECT 1 FROM topups WHERE order_id = ? AND payment_id = ?)", args: [orderId, id] },
    }),
  ]);
  return inserted?.meta.changes === 0 ? "duplicate" : "paid";
}

function paymentStatement(
  db: D1Database,
  id: string,
  orderId: string,
  log: PaidLog,
  matched: boolean,
  note: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO payments (id, order_id, payer, token, amount, block_number, tx_hash, log_index, paid_at, matched, note, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      orderId,
      log.payer.toLowerCase(),
      log.token.toLowerCase(),
      log.amount.toString(),
      Number(log.blockNumber),
      log.txHash.toLowerCase(),
      log.logIndex,
      Number(log.timestamp),
      matched ? 1 : 0,
      note,
      now,
    );
}

function mismatch(order: OrderRow | null, log: PaidLog): string | null {
  if (!order) return "no order with this id";
  if (order.status === "paid") return "the order was already paid";
  if (log.token.toLowerCase() !== order.token.toLowerCase()) return "paid with another token than quoted";
  if (log.amount < BigInt(order.amount)) return `paid ${log.amount} but the quote was ${order.amount}`;
  if (Number(log.timestamp) > order.expires_at + PAYMENT_GRACE_S) return "paid after the quote expired";
  return null;
}

function refundStatement(
  db: D1Database,
  reason: "payment_unmatched" | "overpaid",
  r: { orderId: string; paymentId: string; log: PaidLog; amount: bigint; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO refunds (id, reason, order_id, payment_id, address, token, amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'due', ?)`,
    )
    .bind(
      newId("rf"),
      reason,
      r.orderId,
      r.paymentId,
      r.log.payer.toLowerCase(),
      r.log.token.toLowerCase(),
      r.amount.toString(),
      r.now,
    );
}

/** Scan new blocks for Paid events, up to LOG_RANGES_PER_RUN ranges of LOG_RANGE_BLOCKS. */
export async function scanPayments(
  db: D1Database,
  cfg: Config,
  now: number,
): Promise<{ from: bigint; to: bigint; payments: number }> {
  if (!cfg.router) throw new Error("PAYMENT_ROUTER_ADDRESS is not set");
  const chain = chainFor(cfg);
  const latest = await chain.latestBlock();
  const safeHead = latest - cfg.confirmations;
  if (safeHead < 0n) return { from: 0n, to: 0n, payments: 0 }; // a chain younger than the confirmations
  const stored = await getKv(db, SCAN_CURSOR_KEY);
  let cursor = stored !== null ? BigInt(stored) : cfg.routerDeployBlock > 0n ? cfg.routerDeployBlock : safeHead;
  const from = cursor;
  let payments = 0;
  for (let ranges = 0; ranges < cfg.logRangesPerRun && cursor <= safeHead; ranges++) {
    const to = cursor + cfg.logRange - 1n < safeHead ? cursor + cfg.logRange - 1n : safeHead;
    const logs = await chain.paidLogs(cfg.router, cursor, to);
    for (const log of logs) {
      if ((await recordPayment(db, cfg, log, now)) !== "duplicate") payments++;
    }
    cursor = to + 1n;
    await setKv(db, SCAN_CURSOR_KEY, cursor.toString());
  }
  return { from, to: cursor - 1n, payments };
}

export type TxCheck = "paid" | "pending" | "not_found" | "failed" | "no_payment" | "mismatch";

/** Check a transaction a user submitted for an order or a top-up; records its Paid events. */
export async function checkPaymentTx(
  db: D1Database,
  cfg: Config,
  orderId: string,
  txHash: Hex,
  now: number,
  paidMessage = "Payment confirmed. The run is queued.",
): Promise<{ check: TxCheck; message: string }> {
  if (!cfg.router) throw new Error("PAYMENT_ROUTER_ADDRESS is not set");
  const chain = chainFor(cfg);
  const receipt = await chain.paymentReceipt(cfg.router, txHash);
  if (!receipt) return { check: "not_found", message: "The transaction is not on chain yet. Try again shortly." };
  if (receipt.status === "reverted") return { check: "failed", message: "The transaction reverted; nothing was paid." };
  const latest = await chain.latestBlock();
  if (receipt.blockNumber + cfg.confirmations > latest) {
    return { check: "pending", message: "The payment is waiting for confirmations." };
  }
  if (receipt.paid.length === 0) {
    return { check: "no_payment", message: "This transaction has no payment to the Hyvo payment router." };
  }
  for (const log of receipt.paid) await recordPayment(db, cfg, log, now);
  const settled = await db
    .prepare("SELECT status FROM orders WHERE order_id = ? UNION ALL SELECT status FROM topups WHERE order_id = ?")
    .bind(orderId, orderId)
    .first<{ status: string }>();
  if (settled?.status === "paid") return { check: "paid", message: paidMessage };
  const ours = receipt.paid.find((log) => log.orderId.toLowerCase() === orderId);
  if (!ours) return { check: "no_payment", message: "This transaction paid another order." };
  const note = await db
    .prepare("SELECT note FROM payments WHERE id = ?")
    .bind(`${ours.txHash.toLowerCase()}:${ours.logIndex}`)
    .first<{ note: string | null }>();
  return {
    check: "mismatch",
    message: `The payment does not match the quote (${note?.note ?? "unknown"}); a refund is due.`,
  };
}
