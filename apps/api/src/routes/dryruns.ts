import { DISCLAIMER, DryRunRequest, type DryRunSummary, type DryRunView } from "@hyvo/schema";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAccount } from "../lib/auth";
import { balanceOf, chargeAndQueue, toMicros, toUsd } from "../lib/balance";
import { iso, isoOrNull, nowS } from "../lib/clock";
import { config } from "../lib/config";
import { ApiError, readJson } from "../lib/errors";
import { holderTerms } from "../lib/holder";
import { newRunId } from "../lib/ids";
import { type JobRow } from "../lib/jobs";
import { checkDailyCap, quoteRun } from "../lib/pricing";
import { rateLimit } from "../lib/ratelimit";
import { requireRunId } from "./runs";

const MAX_BODY_BYTES = 256 * 1024;
const LISTED = 20;
const AGENTS_PER_CALL = 8;
const NOT_AN_AUDIT = "A Dry Run is not an audit: it finds what its synthetic users happened to run into.";

/**
 * `/v1/dryruns`: a crowd of synthetic users tries a contract before mainnet (SPEC 11.1), paid from the balance. A report is the wallet's
 * own: it may describe a bug in something not yet live, so it never reaches the gallery and nothing about it goes on-chain.
 */
export const dryruns = new Hono<AppEnv>();

dryruns.use("*", requireAccount);

dryruns.post("/", async (c) => {
  const cfg = config(c.env);
  const db = c.env.DB;
  const now = nowS();
  const account = c.get("address");
  const address = account.toLowerCase();
  await rateLimit(db, "dryrun", address, 5, 60, now);
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_BODY_BYTES) throw new ApiError(413, "too_large", "a submission must be at most 256 KB");
  const body = await readJson(c, DryRunRequest);
  const earlier = await findByRequest(db, address, body.requestId);
  if (earlier) return c.json({ dryRun: view(earlier), disclaimer: DISCLAIMER }, 200);

  const { discountBps, priority } = await holderTerms(db, cfg, account, now);
  const quote = quoteRun(cfg, { agents: body.agents, rounds: body.rounds }, discountBps);
  checkDailyCap(cfg, quote);
  const micros = toMicros(quote.priceUsd);
  const runId = newRunId(now * 1000);
  const spec = {
    description: body.description,
    ...(body.abi ? { abi: body.abi } : {}),
    ...(body.address ? { address: body.address } : {}),
    ...(body.bytecode ? { bytecode: body.bytecode } : {}),
    ...(body.constructorArgs ? { constructorArgs: body.constructorArgs } : {}),
    invariants: body.invariants ?? [],
    agents: body.agents,
    rounds: body.rounds,
    maxCostUsd: quote.maxCostUsd,
    maxLlmCalls: Math.ceil(body.agents / AGENTS_PER_CALL) * body.rounds * 2,
  };
  const insert = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (run_id, order_id, address, source, kind, spec_json, title, listed, priority, status, rounds,
                                   max_cost_usd, timeout_s, created_at, charged_micros, request_id)
       SELECT ?, NULL, ?, 'balance', 'dryrun', ?, ?, 0, ?, 'queued', ?, ?, ?, ?, ?, ?
       WHERE (SELECT amount_micros FROM balances WHERE address = ?) >= ?`,
    )
    .bind(runId, address, JSON.stringify(spec), titleOf(body.description), priority, body.rounds, quote.maxCostUsd, cfg.queue.jobTimeoutS, now, micros, body.requestId ?? null, address, micros);
  if (!(await chargeAndQueue(db, insert, { address, runId, micros, now }))) {
    const raced = await findByRequest(db, address, body.requestId);
    if (raced) return c.json({ dryRun: view(raced), disclaimer: DISCLAIMER }, 200);
    const have = toUsd(await balanceOf(db, address));
    throw new ApiError(402, "insufficient_balance", `this Dry Run costs $${quote.priceUsd.toFixed(2)} and the balance is $${have.toFixed(2)}; top up first`);
  }
  const job = (await findOwn(db, runId, address))!;
  return c.json({ dryRun: view(job), disclaimer: disclaimer() }, 201);
});

dryruns.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM jobs WHERE kind = 'dryrun' AND address = ? ORDER BY created_at DESC, run_id DESC LIMIT ?")
    .bind(c.get("address").toLowerCase(), LISTED)
    .all<JobRow>();
  return c.json({ dryRuns: rows.results.map(view), disclaimer: disclaimer() });
});

dryruns.get("/:runId", async (c) => {
  const job = await findOwn(c.env.DB, requireRunId(c.req.param("runId")), c.get("address").toLowerCase());
  if (!job) throw new ApiError(404, "not_found", "unknown Dry Run");
  return c.json({ dryRun: view(job), disclaimer: disclaimer() });
});

/** The exact `dryrun.json`, for checking its hash. */
dryruns.get("/:runId/report", async (c) => {
  const job = await findOwn(c.env.DB, requireRunId(c.req.param("runId")), c.get("address").toLowerCase());
  if (!job) throw new ApiError(404, "not_found", "unknown Dry Run");
  if (job.status !== "complete" || !job.artifact_key) throw new ApiError(409, "not_ready", "this Dry Run has no report yet");
  const object = await c.env.ARTIFACTS.get(job.artifact_key, "stream");
  // KV reaches other locations up to a minute after a write.
  if (!object) throw new ApiError(503, "not_ready", "the report was just delivered; try again in a moment", 15);
  // Private: it may describe a bug in something not yet live.
  return new Response(object, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" } });
});

function disclaimer(): string {
  return `${DISCLAIMER} ${NOT_AN_AUDIT}`;
}

function titleOf(description: string): string {
  const line = description.split("\n", 1)[0]!.trim();
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}

function findOwn(db: D1Database, runId: string, address: string): Promise<JobRow | null> {
  // Another wallet's Dry Run answers like a missing one.
  return db.prepare("SELECT * FROM jobs WHERE run_id = ? AND kind = 'dryrun' AND address = ?").bind(runId, address).first<JobRow>();
}

async function findByRequest(db: D1Database, address: string, requestId: string | undefined): Promise<JobRow | null> {
  if (!requestId) return null;
  return db.prepare("SELECT * FROM jobs WHERE kind = 'dryrun' AND address = ? AND request_id = ?").bind(address, requestId).first<JobRow>();
}

function view(job: JobRow): DryRunView {
  return {
    runId: job.run_id,
    title: job.title,
    status: job.status,
    progress: job.status === "running" && job.progress_round !== null ? { round: job.progress_round, rounds: job.rounds } : null,
    queuedAt: iso(job.created_at),
    finishedAt: isoOrNull(job.finished_at),
    chargedUsd: toUsd(job.charged_micros ?? 0),
    hash: (job.run_hash as `0x${string}` | null) ?? null,
    summary: job.report_json ? (JSON.parse(job.report_json) as DryRunSummary) : null,
    failReason: job.status === "failed" ? job.fail_reason : null,
    refund: job.status === "failed" ? "credited" : null,
  };
}
