/**
 * Scenario questions and calibration (SPEC 11.2). A run's question and the crowd's lean are in its hash, committed before the
 * date. After the date the founder records the outcome, and the Worker sends `HyvoOracle.resolve` with the keccak-256 of an outcome
 * document that anyone can fetch and check. Misses count as loudly as hits.
 *
 * Sending works like commits (lib/oracle.ts): one processor at a time, and it reads the chain before it sends, so a resolve that
 * landed is never sent twice. A failed send is retried with growing waits.
 */
import {
  canonicalJson,
  DISCLAIMER,
  findViolations,
  keccak256Utf8,
  runIdToBytes32,
  type CalibrationEntry,
  type CalibrationResponse,
  type CalibrationResult,
  type DerivedSummary,
  type OpenQuestion,
  type QuestionInput,
  type QuestionOutcome,
  type ResolveQuestionRequest,
} from "@hyvo/schema";
import type { Hex } from "viem";
import { chainFor } from "./chain";
import { iso, parseIso } from "./clock";
import type { Config } from "./config";
import { ApiError } from "./errors";
import { notify } from "./webhooks";

const RETRY_BASE_S = 60;
const RETRY_MAX_S = 3600;
const CLAIM_S = 120;
const RESEND_AFTER_S = 600;
const LISTED_ENTRIES = 100;
const BUCKETS = [
  { label: "50-60%", from: 0.5, to: 0.6 },
  { label: "60-70%", from: 0.6, to: 0.7 },
  { label: "70-80%", from: 0.7, to: 0.8 },
  { label: "80-90%", from: 0.8, to: 0.9 },
  { label: "90-100%", from: 0.9, to: 1.01 },
];

export interface QuestionRow {
  run_id: string;
  run_id_bytes32: string;
  address: string | null;
  title: string;
  text: string;
  resolves_at: number;
  expectation: "yes" | "no" | "split";
  yes: number;
  no: number;
  unsure: number;
  listed: number;
  created_at: number;
  outcome: QuestionOutcome | null;
  note: string | null;
  evidence_url: string | null;
  outcome_json: string | null;
  outcome_hash: string | null;
  decided_at: number | null;
  status: "pending" | "sent" | "confirmed" | "failed" | null;
  tx_hash: string | null;
  block_number: number | null;
  attempts: number;
  error: string | null;
  next_attempt_at: number | null;
  claimed_until: number | null;
  updated_at: number | null;
}

/** A question as ordered: its date is in range, and its text keeps the copy rules. */
export function checkQuestion(cfg: Config, question: QuestionInput | undefined, now: number): void {
  if (!question) return;
  const at = parseIso(question.resolvesAt);
  const { minDelayS, maxDelayS } = cfg.questions;
  if (at < now + minDelayS || at > now + maxDelayS) {
    const days = Math.round(maxDelayS / 86_400);
    throw new ApiError(400, "bad_request", `a question's date must be at least ${Math.ceil(minDelayS / 3600)} hour(s) and at most ${days} days away`);
  }
  const broken = findViolations(question.text);
  if (broken.length > 0) throw new ApiError(400, "bad_request", "ask a neutral question: this one reads as advice or as a promise");
}

/** Written with the run; `only` makes it conditional on an earlier statement of the same batch. */
export function insertQuestionStatement(
  db: D1Database,
  q: { summary: DerivedSummary; address: string | null; listed: boolean },
  now: number,
  only?: { where: string; args: unknown[] },
): D1PreparedStatement | null {
  const { question, runId, title } = q.summary;
  if (!question) return null;
  return db
    .prepare(
      `INSERT OR IGNORE INTO questions (run_id, run_id_bytes32, address, title, text, resolves_at, expectation, yes, no, unsure, listed, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${only ? `WHERE ${only.where}` : ""}`,
    )
    .bind(
      runId,
      runIdToBytes32(runId),
      q.address,
      title,
      question.text,
      parseIso(question.resolvesAt),
      question.expectation,
      question.yes,
      question.no,
      question.unsure,
      q.listed ? 1 : 0,
      now,
      ...(only?.args ?? []),
    );
}

export function findQuestion(db: D1Database, runId: string): Promise<QuestionRow | null> {
  return db.prepare("SELECT * FROM questions WHERE run_id = ?").bind(runId).first<QuestionRow>();
}

function resultOf(row: QuestionRow): CalibrationResult {
  if (row.outcome === "void") return "void";
  if (row.expectation === "split") return "no_lean";
  return row.expectation === row.outcome ? "hit" : "miss";
}

/**
 * Record what happened. The outcome document is fixed here, once. It waits for the run's commit to be confirmed: `resolve` reverts
 * on a commit that is not on-chain.
 */
export async function decideQuestion(
  db: D1Database,
  runId: string,
  decision: ResolveQuestionRequest,
  now: number,
): Promise<QuestionRow> {
  const row = await findQuestion(db, runId);
  if (!row) throw new ApiError(404, "not_found", "this run has no question");
  if (now < row.resolves_at) throw new ApiError(409, "too_early", `this question's date is ${iso(row.resolves_at)}`);
  if (row.outcome) throw new ApiError(409, "already_resolved", "this question already has its outcome");
  const document = {
    runId,
    question: row.text,
    resolvesAt: iso(row.resolves_at),
    expectation: row.expectation,
    outcome: decision.outcome,
    note: decision.note,
    evidenceUrl: decision.evidenceUrl ?? null,
    decidedAt: iso(now),
  };
  const json = canonicalJson(document);
  const updated = await db
    .prepare(
      `UPDATE questions SET outcome = ?, note = ?, evidence_url = ?, outcome_json = ?, outcome_hash = ?, decided_at = ?, status = 'pending', updated_at = ?
       WHERE run_id = ? AND outcome IS NULL RETURNING *`,
    )
    .bind(decision.outcome, decision.note, decision.evidenceUrl ?? null, json, keccak256Utf8(json), now, now, runId)
    .first<QuestionRow>();
  if (!updated) throw new ApiError(409, "already_resolved", "this question already has its outcome");
  return updated;
}

/** Send or confirm the resolves that need it (oldest first). */
export async function processResolutions(db: D1Database, cfg: Config, baseUrl: string, now: number, limit = 3): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT run_id FROM questions
       WHERE (status IN ('pending', 'sent') OR (status = 'failed' AND next_attempt_at <= ?))
         AND (claimed_until IS NULL OR claimed_until <= ?)
       ORDER BY decided_at LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<{ run_id: string }>();
  for (const row of rows.results) await processResolution(db, cfg, baseUrl, row.run_id, now);
  return rows.results.length;
}

export async function processResolution(db: D1Database, cfg: Config, baseUrl: string, runId: string, now: number): Promise<void> {
  if (!cfg.oracle) return;
  const claimed = await db
    .prepare("UPDATE questions SET claimed_until = ? WHERE run_id = ? AND (claimed_until IS NULL OR claimed_until <= ?)")
    .bind(now + CLAIM_S, runId, now)
    .run();
  if (claimed.meta.changes === 0) return;
  const row = await findQuestion(db, runId);
  if (!row || !row.outcome_hash) return;
  const chain = chainFor(cfg);
  try {
    if (row.status === "sent" && row.tx_hash) {
      const tx = await chain.txStatus(row.tx_hash as Hex);
      if (tx?.status === "success") {
        await update(db, runId, { status: "confirmed", block_number: Number(tx.blockNumber), error: null }, now);
        return await announce(db, row, now);
      }
      if (tx === null && now - (row.updated_at ?? 0) < RESEND_AFTER_S) return await update(db, runId, {}, row.updated_at ?? now); // in flight
    }
    const onChain = await chain.getCommit(cfg.oracle, row.run_id_bytes32 as Hex);
    if (!onChain) {
      // The run's commit has not landed yet: this waits for it without using up its patience.
      return await update(db, runId, { status: "failed", next_attempt_at: now + RETRY_BASE_S, error: "the run's commit is not on-chain yet" }, now);
    }
    if (onChain.resolvedAt > 0n) {
      if (onChain.outcomeHash.toLowerCase() === row.outcome_hash) {
        await update(db, runId, { status: "confirmed", error: null }, now);
        return await announce(db, row, now);
      }
      console.error(JSON.stringify({ level: "error", event: "resolve_conflict", runId }));
      return await update(db, runId, { status: "failed", next_attempt_at: null, error: "the chain holds another outcome for this run" }, now);
    }
    if (onChain.resolvesAt === 0n) {
      return await update(db, runId, { status: "failed", next_attempt_at: null, error: "the commit was made without a date, so it cannot be resolved" }, now);
    }
    // The cron has no request to take an address from, and this link goes on-chain for good.
    if (!baseUrl) throw new Error("PUBLIC_API_URL is not set, so this outcome has no link to send");
    const sent = await chain.sendResolve(cfg.oracle, {
      runIdBytes32: row.run_id_bytes32 as Hex,
      outcomeHash: row.outcome_hash as Hex,
      outcomeUri: `${baseUrl}/v1/runs/${runId}/outcome`,
    });
    await update(db, runId, { status: "sent", tx_hash: sent.toLowerCase(), attempts: row.attempts + 1, next_attempt_at: null, error: null }, now);
  } catch (error) {
    const attempts = row.attempts + 1;
    const message = String((error as { shortMessage?: string; message?: string })?.shortMessage ?? (error as Error)?.message ?? error).slice(0, 300);
    await update(db, runId, { status: "failed", attempts, next_attempt_at: now + Math.min(RETRY_MAX_S, RETRY_BASE_S * 2 ** Math.min(attempts, 16)), error: message }, now);
    console.error(JSON.stringify({ level: "error", event: "resolve_failed", runId, attempts, error: message }));
  }
}

async function update(db: D1Database, runId: string, fields: Partial<QuestionRow>, updatedAt: number): Promise<void> {
  const entries = Object.entries(fields);
  const sets = [...entries.map(([key]) => `${key} = ?`), "claimed_until = NULL", "updated_at = ?"].join(", ");
  await db
    .prepare(`UPDATE questions SET ${sets} WHERE run_id = ?`)
    .bind(...entries.map(([, value]) => value ?? null), updatedAt, runId)
    .run();
}

async function announce(db: D1Database, row: QuestionRow, now: number): Promise<void> {
  try {
    await notify(
      db,
      {
        type: "question.resolved",
        data: { runId: row.run_id, title: row.title, ...(row.outcome ? { outcome: row.outcome } : {}), result: resultOf(row) },
        address: row.address,
        listed: row.listed === 1,
      },
      now,
    );
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "webhook_notify_failed", runId: row.run_id, error: String(error).slice(0, 200) }));
  }
}

function openView(row: QuestionRow, now: number): OpenQuestion {
  return {
    runId: row.run_id,
    title: row.title,
    question: row.text,
    resolvesAt: iso(row.resolves_at),
    expectation: row.expectation,
    yes: row.yes,
    no: row.no,
    unsure: row.unsure,
    overdue: now >= row.resolves_at,
  };
}

function entryView(row: QuestionRow): CalibrationEntry {
  return {
    runId: row.run_id,
    title: row.title,
    question: row.text,
    resolvesAt: iso(row.resolves_at),
    expectation: row.expectation,
    yes: row.yes,
    no: row.no,
    unsure: row.unsure,
    outcome: row.outcome!,
    result: resultOf(row),
    note: row.note ?? "",
    evidenceUrl: row.evidence_url,
    decidedAt: iso(row.decided_at!),
    txHash: (row.tx_hash as Hex | null) ?? null,
    onChain: row.status === "confirmed",
  };
}

/** Questions past their date, with no outcome yet: the founder's list. */
export async function questionsDue(db: D1Database, now: number): Promise<OpenQuestion[]> {
  const rows = await db
    .prepare("SELECT * FROM questions WHERE outcome IS NULL AND resolves_at <= ? ORDER BY resolves_at LIMIT 50")
    .bind(now)
    .all<QuestionRow>();
  return rows.results.map((row) => openView(row, now));
}

/** The public record. It counts every listed question ever resolved, and shows the latest. */
export async function calibration(db: D1Database, now: number): Promise<CalibrationResponse> {
  const rows = await db.prepare("SELECT * FROM questions WHERE listed = 1 ORDER BY COALESCE(decided_at, resolves_at) DESC").all<QuestionRow>();
  const resolved = rows.results.filter((row) => row.outcome);
  const open = rows.results.filter((row) => !row.outcome).reverse();
  const counts = { hits: 0, misses: 0, noLean: 0, void: 0, open: open.length };
  const buckets = BUCKETS.map(({ label }) => ({ label, hits: 0, misses: 0 }));
  for (const row of resolved) {
    const result = resultOf(row);
    if (result === "void") counts.void++;
    else if (result === "no_lean") counts.noLean++;
    else {
      const hit = result === "hit";
      if (hit) counts.hits++;
      else counts.misses++;
      const share = Math.max(row.yes, row.no) / Math.max(1, row.yes + row.no);
      const bucket = buckets[BUCKETS.findIndex(({ from, to }) => share >= from && share < to)];
      if (bucket) {
        if (hit) bucket.hits++;
        else bucket.misses++;
      }
    }
  }
  const decided = counts.hits + counts.misses;
  return {
    counts,
    hitRate: decided > 0 ? counts.hits / decided : null,
    buckets,
    resolved: resolved.slice(0, LISTED_ENTRIES).map(entryView),
    open: open.slice(0, LISTED_ENTRIES).map((row) => openView(row, now)),
    disclaimer: DISCLAIMER,
  };
}
