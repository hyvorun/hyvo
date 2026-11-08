/**
 * The runner queue (SPEC 6.6, 8.2). A job exists only for a paid order or a used holder credit.
 * Runners claim jobs with a lease; every later call must carry it. A job whose runner goes quiet
 * (no heartbeat for HEARTBEAT_TIMEOUT_S, or past its timeout) or reports a failure goes back to
 * the queue once; the second time it fails, and a paid job gets a refund record or, paid from a balance, its money back.
 */
import type { JobSpec, JobView } from "@hyvo/schema";
import { iso, isoOrNull, utcDay, utcMonth } from "./clock";
import { creditStatements } from "./balance";
import type { Config } from "./config";
import { getKv } from "./db";
import { newId, newLeaseId } from "./ids";
import { notify } from "./webhooks";

export const MAX_ATTEMPTS = 2;
/** Beyond the job timeout, how long the API waits for the runner's own kill and report. */
export const TIMEOUT_GRACE_S = 300;
export const QUEUE_PAUSED_KEY = "queue.paused";

export interface JobRow {
  run_id: string;
  order_id: string | null;
  address: string | null;
  source: "paid" | "credit" | "balance";
  spec_json: string;
  title: string;
  listed: number;
  priority: number;
  status: "queued" | "running" | "complete" | "failed";
  attempts: number;
  lease_id: string | null;
  leased_at: number | null;
  heartbeat_at: number | null;
  progress_round: number | null;
  rounds: number;
  max_cost_usd: number;
  timeout_s: number;
  cost_usd: number | null;
  run_hash: string | null;
  run_status: string | null;
  fail_reason: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  upload_sha256: string | null;
  upload_size: number | null;
  upload_hash: string | null;
  charged_micros: number | null;
  request_id: string | null;
  kind: "run" | "dryrun" | "clone";
  report_json: string | null;
  artifact_key: string | null;
}

export interface NewJob {
  runId: string;
  orderId: string | null;
  address: string | null;
  source: "paid" | "credit" | "balance";
  spec: JobSpec;
  listed: boolean;
  priority: number;
  timeoutS: number;
  chargedMicros?: number;
  requestId?: string | null;
}

/**
 * Insert a queued job. For a paid job the row is written only if its order now points at this run
 * (the order update runs first in the same batch), so a job can never be created twice. `only` adds a
 * condition of the caller's: a job paid from a balance is written only if the balance covers it.
 */
export function insertJobStatement(
  db: D1Database,
  job: NewJob,
  now: number,
  only?: { where: string; args: unknown[] },
): D1PreparedStatement {
  const guard = job.orderId ? "WHERE EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND run_id = ?)" : only ? `WHERE ${only.where}` : "";
  const values = [
    job.runId,
    job.orderId,
    job.address,
    job.source,
    JSON.stringify(job.spec),
    job.spec.scenario.title,
    job.listed ? 1 : 0,
    job.priority,
    job.spec.rounds,
    job.spec.maxCostUsd,
    job.timeoutS,
    now,
    job.chargedMicros ?? null,
    job.requestId ?? null,
  ];
  return db
    .prepare(
      `INSERT OR IGNORE INTO jobs (run_id, order_id, address, source, spec_json, title, listed, priority, status, rounds,
                                   max_cost_usd, timeout_s, created_at, charged_micros, request_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ? ${guard}`,
    )
    .bind(...values, ...(job.orderId ? [job.orderId, job.runId] : (only?.args ?? [])));
}

export async function findJob(db: D1Database, runId: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).first<JobRow>();
}

export async function refundState(db: D1Database, runId: string): Promise<"due" | "sent" | null> {
  const row = await db
    .prepare("SELECT status FROM refunds WHERE run_id = ? AND reason = 'run_failed'")
    .bind(runId)
    .first<{ status: "due" | "sent" }>();
  return row?.status ?? null;
}

export function jobView(row: JobRow, refundDue: "due" | "sent" | null): JobView {
  const refund = row.source === "balance" && row.status === "failed" ? ("credited" as const) : refundDue;
  return {
    status: row.status,
    attempt: row.attempts,
    progress:
      row.status === "running" && row.progress_round !== null
        ? { round: row.progress_round, rounds: row.rounds }
        : null,
    queuedAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    refund,
  };
}

/** USD reserved or spent on LLM calls by attempts that started today (UTC). */
export async function spendToday(db: D1Database, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend WHERE day = ?")
    .bind(utcDay(now))
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export type ClaimResult = { job: JobRow } | { idle: "empty" | "paused" | "spend_cap" };

/** Claim the next queued job for a runner, unless the queue is paused or today's cap is reached. */
export async function claimNext(db: D1Database, cfg: Config, now: number): Promise<ClaimResult> {
  if ((await getKv(db, QUEUE_PAUSED_KEY)) === "1") return { idle: "paused" };
  for (let tries = 0; tries < 3; tries++) {
    const next = await db
      .prepare(
        "SELECT run_id, max_cost_usd FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at, run_id LIMIT 1",
      )
      .first<{ run_id: string; max_cost_usd: number }>();
    if (!next) return { idle: "empty" };
    if ((await spendToday(db, now)) + next.max_cost_usd > cfg.queue.dailyCapUsd) return { idle: "spend_cap" };
    const lease = newLeaseId();
    const [claimed] = await db.batch<JobRow>([
      db
        .prepare(
          `UPDATE jobs SET status = 'running', lease_id = ?, leased_at = ?, heartbeat_at = ?, attempts = attempts + 1,
                  started_at = COALESCE(started_at, ?), progress_round = NULL,
                  upload_sha256 = NULL, upload_size = NULL, upload_hash = NULL
           WHERE run_id = ? AND status = 'queued' RETURNING *`,
        )
        .bind(lease, now, now, now, next.run_id),
      db
        .prepare(
          `INSERT INTO spend (run_id, attempt, day, amount_usd)
           SELECT run_id, attempts, ?, max_cost_usd FROM jobs WHERE run_id = ? AND lease_id = ?`,
        )
        .bind(utcDay(now), next.run_id, lease),
    ]);
    const job = claimed?.results[0];
    if (job) return { job };
    // Another runner took it between the SELECT and the UPDATE: try the next one.
  }
  return { idle: "empty" };
}

export type LeaseCheck = { ok: true; job: JobRow } | { ok: false; reason: "not_found" | "lease_lost" };

export async function checkLease(db: D1Database, runId: string, leaseId: string): Promise<LeaseCheck> {
  const job = await findJob(db, runId);
  if (!job) return { ok: false, reason: "not_found" };
  if (job.status !== "running" || job.lease_id !== leaseId) return { ok: false, reason: "lease_lost" };
  return { ok: true, job };
}

export async function heartbeat(
  db: D1Database,
  runId: string,
  leaseId: string,
  round: number | null,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs SET heartbeat_at = ?, progress_round = COALESCE(?, progress_round)
       WHERE run_id = ? AND lease_id = ? AND status = 'running'`,
    )
    .bind(now, round, runId, leaseId)
    .run();
  return result.meta.changes > 0;
}

/**
 * End an attempt that did not publish: back to the queue while attempts remain and the failure
 * may pass, else failed (with a refund record for a paid job, the credit back for a free run).
 */
export async function failAttempt(
  db: D1Database,
  job: JobRow,
  reason: string,
  retryable: boolean,
  now: number,
): Promise<"queued" | "failed"> {
  if (retryable && job.attempts < MAX_ATTEMPTS) {
    const result = await db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_id = NULL, leased_at = NULL, heartbeat_at = NULL,
                progress_round = NULL, fail_reason = ?
         WHERE run_id = ? AND status = 'running' AND lease_id IS ?`,
      )
      .bind(reason.slice(0, 500), job.run_id, job.lease_id)
      .run();
    if (result.meta.changes > 0) return "queued";
  }
  // The refund or the credit is written with the failure, or neither is, and only by the call that
  // ends the attempt: the job is still held when these statements run, and not after.
  const stillHeld = "EXISTS (SELECT 1 FROM jobs WHERE run_id = ? AND status IN ('running', 'queued') AND lease_id IS ?)";
  const owed: D1PreparedStatement[] = [];
  if (job.source === "credit" && job.address) {
    owed.push(
      db
        .prepare(`UPDATE credit_usage SET used = used - 1 WHERE address = ? AND month = ? AND used > 0 AND ${stillHeld}`)
        .bind(job.address, utcMonth(job.created_at), job.run_id, job.lease_id),
    );
  } else if (job.source === "balance" && job.address && job.charged_micros) {
    owed.push(
      ...creditStatements(db, {
        address: job.address,
        micros: job.charged_micros,
        reason: "run_failed",
        runId: job.run_id,
        now,
        only: { where: stillHeld, args: [job.run_id, job.lease_id] },
      }),
    );
  } else if (job.kind === "clone" && job.address) {
    owed.push(
      db
        .prepare(`UPDATE clones SET status = 'failed', error = ?, updated_at = ? WHERE address = ? AND run_id = ? AND ${stillHeld}`)
        .bind(reason.slice(0, 500), now, job.address, job.run_id, job.run_id, job.lease_id),
    );
  } else if (job.order_id) {
    // The quoted amount: the excess of an overpayment has its own refund record.
    owed.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO refunds (id, reason, run_id, order_id, payment_id, address, token, amount, status, created_at)
           SELECT ?, 'run_failed', ?, o.order_id, p.id, p.payer, p.token, o.amount, 'due', ?
           FROM orders o JOIN payments p ON p.id = o.payment_id
           WHERE o.order_id = ? AND ${stillHeld}`,
        )
        .bind(newId("rf"), job.run_id, now, job.order_id, job.run_id, job.lease_id),
    );
  }
  const results = await db.batch([
    ...owed,
    db
      .prepare(
        `UPDATE jobs SET status = 'failed', lease_id = NULL, fail_reason = ?, finished_at = ?
         WHERE run_id = ? AND status IN ('running', 'queued') AND lease_id IS ?`,
      )
      .bind(reason.slice(0, 500), now, job.run_id, job.lease_id),
  ]);
  if ((results.at(-1)?.meta.changes ?? 0) > 0 && job.kind !== "clone") {
    const refund = job.source === "balance" ? ("credited" as const) : job.order_id ? await refundState(db, job.run_id) : null;
    await notify(db, { type: "run.failed", data: { runId: job.run_id, reason: reason.slice(0, 500), refund }, address: job.address, listed: false }, now);
  }
  return "failed";
}

/** Return or fail jobs whose runner went quiet or ran past its timeout. */
export async function sweepStale(
  db: D1Database,
  cfg: Config,
  now: number,
): Promise<{ requeued: number; failed: number }> {
  const quietBefore = now - cfg.queue.heartbeatTimeoutS;
  const stale = await db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'running'
       AND (heartbeat_at < ? OR leased_at + timeout_s + ? < ?)`,
    )
    .bind(quietBefore, TIMEOUT_GRACE_S, now)
    .all<JobRow>();
  let requeued = 0;
  let failed = 0;
  for (const job of stale.results) {
    const overdue = (job.leased_at ?? now) + job.timeout_s + TIMEOUT_GRACE_S < now;
    const reason = overdue ? "the run went past its timeout" : "the runner stopped sending heartbeats";
    const status = await failAttempt(db, job, reason, true, now);
    if (status === "queued") requeued++;
    else failed++;
  }
  return { requeued, failed };
}
