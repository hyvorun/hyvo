import { AskRequest, CreateRunRequest, DISCLAIMER, RunId, type OracleView, type RunResponse } from "@hyvo/schema";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { askRun } from "../lib/ask";
import { requireAccount } from "../lib/auth";
import { startPrepaidRun } from "../lib/balance";
import { iso, nowS } from "../lib/clock";
import { config, type Config } from "../lib/config";
import { featuredRun, findRun, listRuns, toSummary } from "../lib/db";
import { ApiError, readJson } from "../lib/errors";
import { holderStatus, returnCredit, useCredit } from "../lib/holder";
import { newRunId } from "../lib/ids";
import { findJob, insertJobStatement, jobView, refundState } from "../lib/jobs";
import { findCommit } from "../lib/oracle";
import { buildSpec, checkDailyCap, checkSize, creditRun, jobTimeoutFor } from "../lib/pricing";
import { checkQuestion, findQuestion } from "../lib/questions";
import { rateLimit } from "../lib/ratelimit";
import { ARTIFACT_TTL_SECONDS, signArtifact, verifyArtifact } from "../lib/signing";
import { ownOrder } from "./orders";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const runs = new Hono<AppEnv>();

runs.get("/", async (c) => {
  const limit = parseLimit(c.req.query("limit"));
  const after = parseCursor(c.req.query("cursor"));
  const rows = await listRuns(c.env.DB, limit + 1, after);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last.published_at, last.run_id) : null;
  return c.json({ runs: page.map(toSummary), nextCursor, disclaimer: DISCLAIMER });
});

runs.get("/featured", async (c) => {
  const row = await featuredRun(c.env.DB);
  if (!row) throw new ApiError(404, "not_found", "no run has been published yet");
  return c.json({ run: toSummary(row), disclaimer: DISCLAIMER });
});

/**
 * Start a run: for a paid order (idempotent: a paid order already has its run), from the wallet's prepaid
 * balance, or with a holder free run. Nothing runs before payment is confirmed, a balance is debited or a
 * credit is used (money rule 1).
 */
runs.post("/", requireAccount, async (c) => {
  const cfg = config(c.env);
  const db = c.env.DB;
  const now = nowS();
  const address = c.get("address");
  const body = await readJson(c, CreateRunRequest);

  if ("orderId" in body) {
    const order = await ownOrder(db, body.orderId, address);
    const job = order.run_id ? await findJob(db, order.run_id) : null;
    if (!job) {
      const expired = now > order.expires_at;
      throw new ApiError(
        402,
        "payment_required",
        expired ? "the quote expired before it was paid; ask for a new quote" : "pay the order first",
      );
    }
    return c.json({ runId: job.run_id, job: jobView(job, await refundState(db, job.run_id)) });
  }

  if ("balance" in body) {
    await rateLimit(db, "balance-run", address, 10, 60, now);
    const { balance: _, ...request } = body;
    const run = await startPrepaidRun(db, cfg, address, request, now);
    return c.json(
      { runId: run.runId, job: jobView(run.job, await refundState(db, run.runId)), chargedUsd: run.chargedUsd },
      run.created ? 201 : 200,
    );
  }

  await rateLimit(db, "credit-run", address, 10, 60, now);
  if (!cfg.features.holder) throw new ApiError(503, "holder_disabled", "holder benefits are not active yet");
  checkSize(cfg, body);
  checkQuestion(cfg, body.question, now);
  if (body.agents > cfg.holder.freeRunMaxAgents || body.rounds > cfg.holder.freeRunMaxRounds) {
    throw new ApiError(
      400,
      "bad_request",
      `a free run has at most ${cfg.holder.freeRunMaxAgents} agents and ${cfg.holder.freeRunMaxRounds} rounds`,
    );
  }
  const quote = creditRun(cfg, body);
  checkDailyCap(cfg, quote);
  const holder = await holderStatus(db, cfg, address, now);
  if (!holder.eligible) throw new ApiError(403, "not_eligible", "this wallet does not hold enough tokens now and 24 h ago");
  if (holder.freeRunsLeft <= 0 || !(await useCredit(db, cfg, address, now))) {
    throw new ApiError(403, "no_credits", "no free runs are left this month");
  }
  const spec = buildSpec(cfg, body, quote);
  const runId = newRunId(now * 1000);
  try {
    await insertJobStatement(
      db,
      {
        runId,
        orderId: null,
        address: address.toLowerCase(),
        source: "credit",
        spec,
        listed: body.listed !== false,
        priority: 1,
        timeoutS: jobTimeoutFor(cfg, body),
      },
      now,
    ).run();
  } catch (error) {
    await returnCredit(db, address, now);
    throw error;
  }
  const job = (await findJob(db, runId))!;
  return c.json({ runId, job: jobView(job, null) }, 201);
});

runs.get("/:runId", async (c) => {
  return c.json(await runStatus(c.env.DB, config(c.env), requireRunId(c.req.param("runId"))));
});

/** Status and summary: the published run once there is one, the job while it is queued or runs. */
export async function runStatus(db: D1Database, cfg: Config, runId: string): Promise<RunResponse> {
  const [row, found, commit, question] = await Promise.all([findRun(db, runId), findJob(db, runId), findCommit(db, runId), findQuestion(db, runId)]);
  // A Dry Run is its wallet's own (routes/dryruns.ts), and here it does not exist.
  const job = found && found.kind !== "run" ? null : found;
  if (!row && !job) throw new ApiError(404, "not_found", "unknown run");
  const oracle: OracleView | null =
    commit && cfg.oracle
      ? {
          status: commit.status,
          txHash: (commit.tx_hash as `0x${string}` | null) ?? null,
          blockNumber: commit.block_number,
          chainId: cfg.chainId,
          oracleAddress: cfg.oracle,
        }
      : null;
  return {
    run: row ? toSummary(row) : null,
    job: job ? jobView(job, await refundState(db, runId)) : null,
    oracle,
    outcome:
      question?.outcome && question.decided_at !== null
        ? {
            outcome: question.outcome,
            note: question.note ?? "",
            evidenceUrl: question.evidence_url,
            decidedAt: iso(question.decided_at),
            txHash: (question.tx_hash as `0x${string}` | null) ?? null,
            status: question.status ?? "pending",
          }
        : null,
    disclaimer: DISCLAIMER,
  };
}

/** The outcome document of a resolved question: the exact bytes whose keccak-256 is on-chain. */
runs.get("/:runId/outcome", async (c) => {
  const row = await findQuestion(c.env.DB, requireRunId(c.req.param("runId")));
  if (!row?.outcome_json) throw new ApiError(404, "not_found", "this run has no recorded outcome");
  return new Response(row.outcome_json, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
});

/** A follow-up question to one agent of the run, or to its report; paid per call from the balance. */
runs.post("/:runId/ask", requireAccount, async (c) => {
  const runId = requireRunId(c.req.param("runId"));
  const now = nowS();
  const address = c.get("address");
  await rateLimit(c.env.DB, "ask", address, 20, 60, now);
  const body = await readJson(c, AskRequest);
  return c.json(await askRun(c.env, config(c.env), address, { runId, ...body }, now));
});

runs.get("/:runId/artifact", async (c) => {
  const runId = requireRunId(c.req.param("runId"));
  if (!(await findRun(c.env.DB, runId))) throw new ApiError(404, "not_found", "unknown run");
  const exp = nowS() + ARTIFACT_TTL_SECONDS;
  const sig = await signArtifact(c.env.ARTIFACT_SIGNING_KEY, runId, exp);
  const base = c.env.PUBLIC_API_URL || new URL(c.req.url).origin;
  return c.json({
    url: `${base}/v1/artifacts/${runId}/run.json?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString().replace(".000Z", "Z"),
  });
});

/** `GET /v1/artifacts/:runId/run.json?exp&sig`: the exact published bytes. */
export const artifacts = new Hono<AppEnv>();

artifacts.get("/:runId/run.json", async (c) => {
  const runId = requireRunId(c.req.param("runId"));
  const exp = Number(c.req.query("exp"));
  const sig = c.req.query("sig") ?? "";
  if (!Number.isSafeInteger(exp) || !(await verifyArtifact(c.env.ARTIFACT_SIGNING_KEY, runId, exp, sig))) {
    throw new ApiError(403, "bad_signature", "the artifact link is not valid");
  }
  if (exp < nowS()) throw new ApiError(403, "expired", "the artifact link has expired");
  const row = await findRun(c.env.DB, runId);
  if (!row) throw new ApiError(404, "not_found", "unknown run");
  const object = await c.env.ARTIFACTS.get(row.artifact_key, "stream");
  // KV reaches other locations up to a minute after a write.
  if (!object) throw new ApiError(503, "not_ready", "the run was just published; try again in a moment", 15);
  return new Response(object, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // A published run never changes; the URL also carries its own expiry.
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${row.hash}"`,
    },
  });
});

export function requireRunId(value: string): string {
  if (!RunId.safeParse(value).success) throw new ApiError(404, "not_found", "unknown run");
  return value;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ApiError(400, "bad_request", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function encodeCursor(publishedAt: string, runId: string): string {
  return btoa(`${publishedAt}|${runId}`).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseCursor(value: string | undefined): { publishedAt: string; runId: string } | null {
  if (!value) return null;
  try {
    const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const [publishedAt, runId] = text.split("|");
    if (publishedAt && runId && RunId.safeParse(runId).success) return { publishedAt, runId };
  } catch {
    // fall through to the error below
  }
  throw new ApiError(400, "bad_request", "invalid cursor");
}
