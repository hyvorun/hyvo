/**
 * Oracle commits (SPEC 8.4): when a run is published the Worker queues
 * `HyvoOracle.commit(runIdBytes32, reportHash, scenarioHash, 0)` and sends it with the attester key.
 * `reportHash` is the run hash and `scenarioHash` the hash of `run.scenario` (docs/RUN_FORMAT.md).
 *
 * One processor works on a commit at a time (a short claim in D1), and it reads the chain before
 * sending, so a commit that already landed is never sent again. A failed send is retried with
 * growing waits for as long as it takes (the attester can run out of gas for days); only a chain
 * that holds another hash for the run ends the retries.
 */
import type { Hex } from "viem";
import { chainFor } from "./chain";
import type { Config } from "./config";
import { notify } from "./webhooks";

/** A sent transaction that is still unknown after this long is sent again. */
const RESEND_AFTER_S = 600;
/** How long a processor holds a commit; longer than the RPC calls it makes. */
const CLAIM_S = 120;
const RETRY_BASE_S = 60;
const RETRY_MAX_S = 3600;

export interface CommitRow {
  run_id: string;
  run_id_bytes32: string;
  report_hash: string;
  scenario_hash: string;
  status: "pending" | "sent" | "confirmed" | "failed";
  tx_hash: string | null;
  block_number: number | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
  claimed_until: number | null;
  next_attempt_at: number | null;
  resolves_at: number | null;
}

/** Queue a commit; `where` makes it conditional on an earlier statement of the same batch. */
export function queueCommitStatement(
  db: D1Database,
  c: { runId: string; runIdBytes32: string; reportHash: string; scenarioHash: string; resolvesAt?: number | null },
  now: number,
  only?: { where: string; args: unknown[] },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO oracle_commits (run_id, run_id_bytes32, report_hash, scenario_hash, resolves_at, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'pending', ?, ? ${only ? `WHERE ${only.where}` : ""}`,
    )
    .bind(c.runId, c.runIdBytes32, c.reportHash, c.scenarioHash, c.resolvesAt ?? null, now, now, ...(only?.args ?? []));
}

export async function findCommit(db: D1Database, runId: string): Promise<CommitRow | null> {
  return db.prepare("SELECT * FROM oracle_commits WHERE run_id = ?").bind(runId).first<CommitRow>();
}

/** Send or confirm the commits that need it (oldest first). */
export async function processCommits(db: D1Database, cfg: Config, now: number, limit = 5): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT run_id FROM oracle_commits
       WHERE (status IN ('pending', 'sent') OR (status = 'failed' AND next_attempt_at <= ?))
         AND (claimed_until IS NULL OR claimed_until <= ?)
       ORDER BY created_at LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<{ run_id: string }>();
  for (const row of rows.results) await processCommit(db, cfg, row.run_id, now);
  return rows.results.length;
}

/** Take one commit one step further, unless another processor holds it. */
export async function processCommit(db: D1Database, cfg: Config, runId: string, now: number): Promise<void> {
  if (!cfg.oracle) return;
  const claimed = await db
    .prepare(
      `UPDATE oracle_commits SET claimed_until = ?
       WHERE run_id = ? AND (claimed_until IS NULL OR claimed_until <= ?)`,
    )
    .bind(now + CLAIM_S, runId, now)
    .run();
  if (claimed.meta.changes === 0) return;
  // Read after the claim: a processor that just finished may have changed it.
  const row = await findCommit(db, runId);
  if (!row) return;
  const chain = chainFor(cfg);
  try {
    let txHash = row.tx_hash;
    if (row.status === "confirmed") return await update(db, runId, {}, now);
    if (row.status === "sent" && txHash) {
      const tx = await chain.txStatus(txHash as Hex);
      if (tx?.status === "success") {
        await update(db, runId, { status: "confirmed", block_number: Number(tx.blockNumber), confirmed_at: now }, now);
        return await announce(db, row, txHash, Number(tx.blockNumber), now);
      }
      if (tx === null && now - row.updated_at < RESEND_AFTER_S) {
        return await update(db, runId, {}, row.updated_at); // still in flight
      }
      if (tx?.status === "reverted") txHash = null; // never show it as the commit
    }
    const onChain = await chain.getCommit(cfg.oracle, row.run_id_bytes32 as Hex);
    if (onChain) {
      if (onChain.reportHash.toLowerCase() === row.report_hash) {
        await update(db, runId, { status: "confirmed", tx_hash: txHash, confirmed_at: now }, now);
        return await announce(db, row, txHash, row.block_number, now);
      }
      console.error(JSON.stringify({ level: "error", event: "oracle_conflict", runId }));
      return await update(
        db,
        runId,
        { status: "failed", next_attempt_at: null, error: "the chain holds another hash for this run" },
        now,
      );
    }
    const sent = await chain.sendCommit(cfg.oracle, {
      runIdBytes32: row.run_id_bytes32 as Hex,
      reportHash: row.report_hash as Hex,
      scenarioHash: row.scenario_hash as Hex,
      resolvesAt: BigInt(row.resolves_at ?? 0),
    });
    await update(
      db,
      runId,
      { status: "sent", tx_hash: sent.toLowerCase(), attempts: row.attempts + 1, next_attempt_at: null, error: null },
      now,
    );
  } catch (error) {
    const message = errorText(error);
    const attempts = row.attempts + 1;
    await update(
      db,
      runId,
      { status: "failed", attempts, next_attempt_at: now + retryWait(attempts), error: message },
      now,
    );
    console.error(JSON.stringify({ level: "error", event: "oracle_commit_failed", runId, attempts, error: message }));
  }
}

/** Tell webhooks. A failure here must not look like a failed commit: the commit is on-chain. */
async function announce(db: D1Database, row: CommitRow, txHash: string | null, blockNumber: number | null, now: number): Promise<void> {
  try {
    const run = await db
      .prepare("SELECT r.listed AS listed, j.address AS address FROM runs r LEFT JOIN jobs j ON j.run_id = r.run_id WHERE r.run_id = ?")
      .bind(row.run_id)
      .first<{ listed: number; address: string | null }>();
    await notify(
      db,
      {
        type: "oracle.committed",
        data: { runId: row.run_id, hash: row.report_hash as Hex, ...(txHash ? { txHash: txHash as Hex } : {}), blockNumber },
        address: run?.address ?? null,
        listed: run?.listed === 1,
      },
      now,
    );
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "webhook_notify_failed", runId: row.run_id, error: String(error).slice(0, 200) }));
  }
}

function retryWait(attempts: number): number {
  return Math.min(RETRY_MAX_S, RETRY_BASE_S * 2 ** Math.min(attempts, 16));
}

/** Write fields and release the claim. */
async function update(db: D1Database, runId: string, fields: Partial<CommitRow>, updatedAt: number): Promise<void> {
  const entries = Object.entries(fields);
  const sets = [...entries.map(([key]) => `${key} = ?`), "claimed_until = NULL", "updated_at = ?"].join(", ");
  await db
    .prepare(`UPDATE oracle_commits SET ${sets} WHERE run_id = ?`)
    .bind(...entries.map(([, value]) => value ?? null), updatedAt, runId)
    .run();
}

/** A short error without request bodies (which could carry signed transactions). */
function errorText(error: unknown): string {
  const e = error as { shortMessage?: string; name?: string; message?: string } | null;
  return String(e?.shortMessage ?? e?.message ?? e?.name ?? error).slice(0, 300);
}
