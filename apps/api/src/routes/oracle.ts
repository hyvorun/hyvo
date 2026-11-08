import { DISCLAIMER, type OnChainCommit, type OracleEntry, type OracleRunResponse } from "@hyvo/schema";
import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../env";
import { chainFor } from "../lib/chain";
import { isoOrNull, nowS } from "../lib/clock";
import { config, type Config } from "../lib/config";
import { ApiError } from "../lib/errors";
import { findCommit, type CommitRow } from "../lib/oracle";
import { calibration } from "../lib/questions";
import { clientIp, rateLimit } from "../lib/ratelimit";
import { requireRunId } from "./runs";

const PAGE = 25;

/** `/v1/calibration`: how often the crowd's lean matched what happened, misses as plainly as hits. */
export const calibrationRoute = new Hono<AppEnv>();

calibrationRoute.get("/", async (c) => c.json(await calibration(c.env.DB, nowS())));

/** `/v1/oracle`: the ledger of commits, and one run's commit read from the chain. */
export const oracle = new Hono<AppEnv>();

type LedgerRow = CommitRow & { title: string | null; listed: number | null };

oracle.get("/", async (c) => {
  const cfg = config(c.env);
  const cursor = parseCursor(c.req.query("cursor"));
  const where = cursor ? "WHERE (o.created_at, o.run_id) < (?, ?)" : "";
  const statement = c.env.DB.prepare(
    `SELECT o.*, r.title AS title, r.listed AS listed FROM oracle_commits o LEFT JOIN runs r ON r.run_id = o.run_id
     ${where} ORDER BY o.created_at DESC, o.run_id DESC LIMIT ?`,
  );
  const rows = await (cursor ? statement.bind(cursor.createdAt, cursor.runId, PAGE + 1) : statement.bind(PAGE + 1)).all<LedgerRow>();
  const page = rows.results.slice(0, PAGE);
  const last = page.at(-1);
  return c.json({
    chainId: cfg.chainId,
    oracleAddress: cfg.oracle,
    entries: page.map(entry),
    nextCursor: rows.results.length > PAGE && last ? `${last.created_at}.${last.run_id}` : null,
    disclaimer: DISCLAIMER,
  });
});

oracle.get("/:runId", async (c) => {
  const runId = requireRunId(c.req.param("runId"));
  await rateLimit(c.env.DB, "oracle-run", clientIp(c), 60, 60, nowS()); // it reads the chain
  return c.json(await oracleStatus(c.env.DB, config(c.env), runId));
});

/** A run's commit, as recorded and as read from the chain; a 404 `ApiError` when it has none. */
export async function oracleStatus(db: D1Database, cfg: Config, runId: string): Promise<OracleRunResponse> {
  const commit = await findCommit(db, runId);
  if (!commit) throw new ApiError(404, "not_found", "this run has no oracle commit");
  const run = await db.prepare("SELECT title, listed FROM runs WHERE run_id = ?")
    .bind(runId)
    .first<{ title: string; listed: number }>();
  let onChain: OnChainCommit | null = null;
  if (cfg.oracle && cfg.rpcUrls.length > 0) {
    try {
      const read = await chainFor(cfg).getCommit(cfg.oracle, commit.run_id_bytes32 as Hex);
      if (read) {
        onChain = {
          reportHash: read.reportHash.toLowerCase() as Hex,
          scenarioHash: read.scenarioHash.toLowerCase() as Hex,
          resolvesAt: Number(read.resolvesAt),
          committedAt: Number(read.committedAt),
          resolvedAt: Number(read.resolvedAt),
          outcomeHash: read.outcomeHash.toLowerCase() as Hex,
        };
      }
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "oracle_read_failed", runId, error: String(error).slice(0, 200) }));
    }
  }
  return {
    entry: entry({ ...commit, title: run?.title ?? null, listed: run?.listed ?? null }),
    chainId: cfg.chainId,
    oracleAddress: cfg.oracle,
    onChain,
    matches: onChain
      ? onChain.reportHash === commit.report_hash && onChain.scenarioHash === commit.scenario_hash
      : null,
    disclaimer: DISCLAIMER,
  };
}

function entry(row: LedgerRow): OracleEntry {
  return {
    runId: row.run_id,
    runIdBytes32: row.run_id_bytes32 as Hex,
    reportHash: row.report_hash as Hex,
    scenarioHash: row.scenario_hash as Hex,
    title: row.listed === 1 ? row.title : null,
    status: row.status,
    txHash: (row.tx_hash as Hex | null) ?? null,
    blockNumber: row.block_number,
    committedAt: isoOrNull(row.confirmed_at),
  };
}

function parseCursor(value: string | undefined): { createdAt: number; runId: string } | null {
  if (!value) return null;
  const match = /^([0-9]{1,12})\.(run_[0-9A-Z]{26})$/.exec(value);
  if (!match) throw new ApiError(400, "bad_request", "invalid cursor");
  return { createdAt: Number(match[1]), runId: match[2]! };
}
