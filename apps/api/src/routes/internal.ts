import {
  DryRunMeta,
  CloneProfile,
  PERSONAS,
  PublishMeta,
  RunMeta,
  runIdToBytes32,
  type DerivedSummary,
  type JobSpec,
  type RunnerJob,
} from "@hyvo/schema";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { inBackground } from "../lib/background";
import { iso, nowS, parseIso } from "../lib/clock";
import { config } from "../lib/config";
import { findRun, insertRun, insertRunStatement, type RunRow } from "../lib/db";
import { ApiError, readJson } from "../lib/errors";
import { sha256Bytes } from "../lib/ids";
import {
  checkLease,
  claimNext,
  failAttempt,
  heartbeat,
  sweepStale,
  type JobRow,
} from "../lib/jobs";
import { processCommit, queueCommitStatement } from "../lib/oracle";
import { insertQuestionStatement } from "../lib/questions";
import { checkRunBytes, MAX_RUN_BYTES, parseRunBytes, readRunBody, tooLarge } from "../lib/runfile";
import { notify } from "../lib/webhooks";
import { sameSecret, signUpload, UPLOAD_TTL_SECONDS, verifyUpload } from "../lib/signing";

/** Runner-only routes (`Authorization: Bearer <RUNNER_TOKEN>`). */
export const internal = new Hono<AppEnv>();

internal.use("*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!(await sameSecret(token, c.env.RUNNER_TOKEN))) {
    throw new ApiError(401, "unauthorized", "a valid runner token is required");
  }
  await next();
});

/** Room for the metadata line in front of the run in `POST /internal/runs/publish`. */
const MAX_META_BYTES = 64 * 1024;

/**
 * Publish a run.json by hand (`hyvo publish`); runner jobs publish through `complete`. The body is
 * one line of JSON metadata (`PublishMeta`), a newline, then the exact run.json bytes.
 */
internal.post("/runs/publish", async (c) => {
  const cfg = config(c.env);
  const body = await readRunBody(c.req.raw, MAX_RUN_BYTES + MAX_META_BYTES);
  const split = body.indexOf(0x0a);
  if (split < 0 || split > MAX_META_BYTES) throw new ApiError(400, "bad_request", "the body must start with a line of metadata");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body.subarray(0, split)));
  } catch {
    throw new ApiError(400, "bad_request", "the metadata line is not JSON");
  }
  const meta = PublishMeta.safeParse(raw);
  if (!meta.success) throw new ApiError(400, "bad_request", "the metadata line does not match PublishMeta");
  const { hash, sha256, summary, featured, scenarioHash } = meta.data;
  const bytes = body.subarray(split + 1);
  if (bytes.byteLength > MAX_RUN_BYTES) throw tooLarge();
  checkRunBytes(bytes);
  if ((await sha256Bytes(bytes)) !== sha256) throw new ApiError(400, "invalid_run", "the bytes do not match the sha256 sent");
  if (summary.hash !== hash) throw new ApiError(400, "invalid_run", "the summary is for another hash");
  if (cfg.verifyRuns) {
    const run = parseRunBytes(bytes);
    if (run.hash !== hash || run.runId !== summary.runId) throw new ApiError(400, "invalid_run", "the metadata is for another run");
  }

  const runId = summary.runId;
  // With the oracle on, a run published by hand goes on-chain like a paid one. Publishing a run again
  // commits one that went out before the oracle was on, unless it has been taken out of the gallery:
  // a commit cannot be undone. A commit that exists stays as it is.
  const commit = async () => {
    if (!cfg.features.oracle || !scenarioHash) return;
    const now = nowS();
    await queueCommitStatement(c.env.DB, { runId, runIdBytes32: runIdToBytes32(runId), reportHash: hash, scenarioHash, resolvesAt: resolvesAtOf(summary) }, now).run();
    inBackground(c, processCommit(c.env.DB, cfg, runId, now));
  };
  const existing = await findRun(c.env.DB, runId);
  if (existing) {
    if (existing.hash !== hash) throw new ApiError(409, "conflict", "this runId was published with a different hash");
    if (existing.listed === 1) await commit();
    return c.json({ runId, hash, publishedAt: existing.published_at }, 200);
  }
  const artifactKey = `runs/${runId}/run.json`;
  await c.env.ARTIFACTS.put(artifactKey, bytes);
  const publishedAt = iso(nowS());
  await insertRun(c.env.DB, {
    derived: summary,
    publishedAt,
    featured: featured === true,
    listed: true,
    artifactKey,
    sizeBytes: bytes.byteLength,
  });
  await insertQuestionStatement(c.env.DB, { summary, address: null, listed: true }, nowS())?.run();
  await notify(c.env.DB, { type: "run.published", data: { runId, hash, title: summary.title, status: summary.status }, address: null, listed: true }, nowS());
  await commit();
  return c.json({ runId, hash, publishedAt }, 201);
});

// --- the job queue (docs/API.md, "Runner jobs") ----------------------------------------------

const LeaseId = z.string().min(1).max(100);
const LeaseBody = z.strictObject({ leaseId: LeaseId });
const HeartbeatBody = z.strictObject({
  leaseId: LeaseId,
  progress: z.strictObject({ round: z.int().min(0), rounds: z.int().min(1) }).optional(),
});
const CompleteBody = RunMeta.extend({ leaseId: LeaseId });
const DryRunCompleteBody = DryRunMeta.extend({ leaseId: LeaseId });
const CloneCompleteBody = z.strictObject({ leaseId: LeaseId, profile: CloneProfile });
const FailBody = z.strictObject({
  leaseId: LeaseId,
  reason: z.string().max(4000), // kept to 500 characters when stored
  retryable: z.boolean().default(true),
});

internal.get("/jobs/next", async (c) => {
  const cfg = config(c.env);
  const now = nowS();
  await sweepStale(c.env.DB, cfg, now);
  const claim = await claimNext(c.env.DB, cfg, now);
  if ("idle" in claim) {
    c.header("X-Hyvo-Queue", claim.idle);
    return c.body(null, 204);
  }
  const job = claim.job;
  const body: { job: RunnerJob } = {
    job: {
      runId: job.run_id,
      leaseId: job.lease_id!,
      attempt: job.attempts,
      heartbeatIntervalS: cfg.queue.heartbeatIntervalS,
      timeoutS: job.timeout_s,
      // A Dry Run's or a clone's spec is its own; `kind` tells the runner which to expect. A run has no `kind`, as before.
      ...(job.kind === "run" ? {} : { kind: job.kind }),
      spec: JSON.parse(job.spec_json) as JobSpec,
    },
  };
  console.log(JSON.stringify({ level: "info", event: "job_claimed", runId: job.run_id, attempt: job.attempts }));
  return c.json(body);
});

internal.post("/jobs/:runId/heartbeat", async (c) => {
  const body = await readJson(c, HeartbeatBody);
  const runId = c.req.param("runId");
  const round = body.progress ? Math.min(body.progress.round, body.progress.rounds) : null;
  if (!(await heartbeat(c.env.DB, runId, body.leaseId, round, nowS()))) await leaseProblem(c.env.DB, runId, body.leaseId);
  return c.json({ ok: true as const });
});

internal.post("/jobs/:runId/upload-url", async (c) => {
  const body = await readJson(c, LeaseBody);
  const runId = c.req.param("runId");
  await requireLease(c.env.DB, runId, body.leaseId);
  const exp = nowS() + UPLOAD_TTL_SECONDS;
  const sig = await signUpload(c.env.ARTIFACT_SIGNING_KEY, runId, body.leaseId, exp);
  const base = c.env.PUBLIC_API_URL || new URL(c.req.url).origin;
  const query = new URLSearchParams({ lease: body.leaseId, exp: String(exp), sig });
  return c.json({
    url: `${base}/uploads/${runId}?${query}`,
    method: "PUT" as const,
    headers: { "Content-Type": "application/json" },
    expiresAt: iso(exp),
    maxBytes: MAX_RUN_BYTES,
  });
});

internal.post("/jobs/:runId/complete", async (c) => {
  const runId = c.req.param("runId");
  const cfg = config(c.env);
  const db = c.env.DB;
  const now = nowS();
  const job = await db.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(runId).first<JobRow>();
  if (job?.kind === "dryrun") {
    const delivered = await readJson(c, DryRunCompleteBody);
    return c.json(await completeDryRun(db, job, delivered, now));
  }
  if (job?.kind === "clone") {
    const delivered = await readJson(c, CloneCompleteBody);
    return c.json(await completeClone(db, job, delivered, now));
  }
  const body = await readJson(c, CompleteBody);
  const { leaseId, hash, sha256, scenarioHash, summary, usage } = body;
  if (job?.status === "complete" && job.lease_id === leaseId && job.run_hash === hash) {
    return c.json(completeAnswer(runId, hash, await findRun(db, runId)));
  }
  const held = await requireLease(db, runId, leaseId);

  if (!held.upload_sha256) throw new ApiError(422, "missing_upload", "upload run.json to the signed URL first");
  if (held.upload_sha256 !== sha256) throw new ApiError(422, "run_mismatch", "the sha256 sent is not the upload's");
  if (cfg.verifyRuns && held.upload_hash !== hash) throw new ApiError(422, "run_mismatch", "the hash sent is not the upload's");
  const spec = JSON.parse(held.spec_json) as JobSpec;
  const problem = jobMismatch(body, runId, spec);
  if (problem) throw new ApiError(422, "run_mismatch", problem);

  const existing = await findRun(db, runId);
  if (existing && existing.hash !== hash) {
    throw new ApiError(409, "conflict", "this runId was published with a different hash");
  }
  const publishedAt = iso(now);
  // The first statement ends the job if this runner still holds it; the others apply only if it did.
  const ended = {
    where: "EXISTS (SELECT 1 FROM jobs WHERE run_id = ? AND status = 'complete' AND lease_id = ? AND run_hash = ?)",
    args: [runId, leaseId, hash],
  };
  const statements = [
    db
      .prepare(
        `UPDATE jobs SET status = 'complete', finished_at = ?, run_hash = ?, run_status = ?, cost_usd = ?, progress_round = ?
         WHERE run_id = ? AND lease_id = ? AND status = 'running'`,
      )
      .bind(now, hash, summary.status, usage.costUsd, summary.rounds, runId, leaseId),
    db
      .prepare(`UPDATE spend SET amount_usd = ?, final = 1 WHERE run_id = ? AND attempt = ? AND ${ended.where}`)
      .bind(usage.costUsd, runId, held.attempts, ...ended.args),
  ];
  if (!existing) {
    statements.push(
      insertRunStatement(
        db,
        {
          derived: summary,
          publishedAt,
          featured: false,
          listed: held.listed === 1,
          artifactKey: uploadKey(runId, leaseId),
          sizeBytes: held.upload_size ?? 0,
        },
        ended,
      ),
    );
  }
  if (cfg.features.oracle) {
    statements.push(
      queueCommitStatement(
        db,
        { runId, runIdBytes32: runIdToBytes32(runId), reportHash: hash, scenarioHash, resolvesAt: resolvesAtOf(summary) },
        now,
        ended,
      ),
    );
  }
  const question = insertQuestionStatement(db, { summary, address: held.address, listed: held.listed === 1 }, now, ended);
  if (question) statements.push(question);
  const [finished] = await db.batch(statements);
  if (finished?.meta.changes === 0) throw new ApiError(409, "lease_lost", "this runner no longer holds the job");
  console.log(JSON.stringify({ level: "info", event: "job_complete", runId, status: summary.status, costUsd: usage.costUsd }));
  const data = { runId, hash, title: summary.title, status: summary.status };
  await notify(db, { type: "run.completed", data, address: held.address, listed: false }, now);
  if (!existing) await notify(db, { type: "run.published", data, address: held.address, listed: held.listed === 1 }, now);
  // The engine's budget check works on estimates, so a run can end a call over budget. That money
  // is spent and the run is what was paid for: publish it, and leave a trace for the founder.
  if (usage.costUsd > spec.maxCostUsd + 1e-6 || usage.llmCalls > spec.maxLlmCalls) {
    console.warn(JSON.stringify({ level: "warn", event: "job_over_budget", runId, costUsd: usage.costUsd, llmCalls: usage.llmCalls }));
  }
  if (cfg.features.oracle) inBackground(c, processCommit(db, cfg, runId, now));
  return c.json(completeAnswer(runId, hash, await findRun(db, runId)));
});

internal.post("/jobs/:runId/fail", async (c) => {
  const body = await readJson(c, FailBody);
  const runId = c.req.param("runId");
  const job = await requireLease(c.env.DB, runId, body.leaseId);
  const status = await failAttempt(c.env.DB, job, body.reason, body.retryable, nowS());
  console.log(JSON.stringify({ level: "warn", event: "job_attempt_failed", runId, attempt: job.attempts, status }));
  return c.json({ status });
});

// --- the signed upload (no runner token: the signature authorizes it) -------------------------

export const uploads = new Hono<AppEnv>();

/**
 * Store a run.json as sent and record its SHA-256 (native, whatever the size). On the Workers Free
 * plan the run is not parsed or re-hashed here: see docs/OPEN_ITEMS.md item 21.
 */
uploads.put("/:runId", async (c) => {
  const runId = c.req.param("runId");
  const lease = c.req.query("lease") ?? "";
  const exp = Number(c.req.query("exp"));
  const sig = c.req.query("sig") ?? "";
  if (!Number.isSafeInteger(exp) || !(await verifyUpload(c.env.ARTIFACT_SIGNING_KEY, runId, lease, exp, sig))) {
    throw new ApiError(403, "bad_signature", "the upload link is not valid");
  }
  if (exp < nowS()) throw new ApiError(403, "expired", "the upload link has expired");
  await requireLease(c.env.DB, runId, lease);
  const bytes = await readRunBody(c.req.raw);
  checkRunBytes(bytes);
  const verifiedHash = config(c.env).verifyRuns ? parseRunBytes(bytes).hash : null;
  const sha256 = await sha256Bytes(bytes);
  await c.env.ARTIFACTS.put(uploadKey(runId, lease), bytes);
  await c.env.DB.prepare(
    "UPDATE jobs SET upload_sha256 = ?, upload_size = ?, upload_hash = ? WHERE run_id = ? AND lease_id = ? AND status = 'running'",
  )
    .bind(sha256, bytes.byteLength, verifiedHash, runId, lease)
    .run();
  return c.json({ size: bytes.byteLength, sha256 });
});

// --- helpers ----------------------------------------------------------------------------------

/** Per attempt, so a stale copy of an earlier attempt can never be served for the published run. */
/** A Dry Run's report stays with its wallet: it enters neither the gallery nor the chain. */
async function completeDryRun(db: D1Database, job: JobRow, body: z.infer<typeof DryRunCompleteBody>, now: number) {
  const { leaseId, hash, sha256, summary, usage } = body;
  const runId = job.run_id;
  if (job.status === "complete" && job.lease_id === leaseId && job.run_hash === hash) return { status: "complete", runId, hash };
  const held = await requireLease(db, runId, leaseId);
  if (!held.upload_sha256) throw new ApiError(422, "missing_upload", "upload dryrun.json to the signed URL first");
  if (held.upload_sha256 !== sha256) throw new ApiError(422, "run_mismatch", "the sha256 sent is not the upload's");
  const [finished] = await db.batch([
    db
      .prepare(
        `UPDATE jobs SET status = 'complete', finished_at = ?, run_hash = ?, run_status = ?, cost_usd = ?, report_json = ?, artifact_key = ?
         WHERE run_id = ? AND lease_id = ? AND status = 'running'`,
      )
      .bind(now, hash, summary.status, usage.costUsd, JSON.stringify(summary), uploadKey(runId, leaseId), runId, leaseId),
    db
      .prepare(
        `UPDATE spend SET amount_usd = ?, final = 1 WHERE run_id = ? AND attempt = ?
         AND EXISTS (SELECT 1 FROM jobs WHERE run_id = ? AND status = 'complete' AND lease_id = ? AND run_hash = ?)`,
      )
      .bind(usage.costUsd, runId, held.attempts, runId, leaseId, hash),
  ]);
  if (finished?.meta.changes === 0) throw new ApiError(409, "lease_lost", "this runner no longer holds the job");
  console.log(JSON.stringify({ level: "info", event: "dryrun_complete", runId, costUsd: usage.costUsd }));
  await notify(db, { type: "run.completed", data: { runId, hash, title: held.title, status: summary.status }, address: held.address, listed: false }, now);
  return { status: "complete", runId, hash };
}

/** A clone's numbers go to its own row, only if that row still waits for this job: a clone deleted in the meantime stays deleted. */
async function completeClone(db: D1Database, job: JobRow, body: z.infer<typeof CloneCompleteBody>, now: number) {
  const { leaseId, profile } = body;
  const runId = job.run_id;
  if (job.status === "complete" && job.lease_id === leaseId) return { status: "complete", runId };
  const held = await requireLease(db, runId, leaseId);
  const ended = "EXISTS (SELECT 1 FROM jobs WHERE run_id = ? AND status = 'complete' AND lease_id = ?)";
  const [finished] = await db.batch([
    db
      .prepare("UPDATE jobs SET status = 'complete', finished_at = ?, run_status = 'complete', cost_usd = 0, progress_round = 1 WHERE run_id = ? AND lease_id = ? AND status = 'running'")
      .bind(now, runId, leaseId),
    db.prepare(`UPDATE spend SET amount_usd = 0, final = 1 WHERE run_id = ? AND attempt = ? AND ${ended}`).bind(runId, held.attempts, runId, leaseId),
    db
      .prepare(`UPDATE clones SET status = 'ready', profile_json = ?, error = NULL, updated_at = ? WHERE address = ? AND run_id = ? AND ${ended}`)
      .bind(JSON.stringify(profile), now, job.address, runId, runId, leaseId),
  ]);
  if (finished?.meta.changes === 0) throw new ApiError(409, "lease_lost", "this runner no longer holds the job");
  console.log(JSON.stringify({ level: "info", event: "clone_built", runId }));
  return { status: "complete", runId };
}

function resolvesAtOf(summary: DerivedSummary): number | null {
  return summary.question ? parseIso(summary.question.resolvesAt) : null;
}

function uploadKey(runId: string, leaseId: string): string {
  return `runs/${runId}/${leaseId}.json`;
}

async function requireLease(db: D1Database, runId: string, leaseId: string): Promise<JobRow> {
  const check = await checkLease(db, runId, leaseId);
  if (check.ok) return check.job;
  if (check.reason === "not_found") throw new ApiError(404, "not_found", "unknown job");
  throw new ApiError(409, "lease_lost", "this runner no longer holds the job");
}

async function leaseProblem(db: D1Database, runId: string, leaseId: string): Promise<never> {
  await requireLease(db, runId, leaseId);
  throw new ApiError(409, "lease_lost", "this runner no longer holds the job");
}

/** The run the runner reports must be the job that was ordered. Text is not compared: the engine sanitizes it. */
function jobMismatch(meta: RunMeta, runId: string, spec: JobSpec): string | null {
  const { summary } = meta;
  if (summary.runId !== runId) return `the run carries runId ${summary.runId}`;
  if (summary.hash !== meta.hash) return "the summary is for another hash";
  if (summary.crowdSize !== spec.agents) return `the crowd has ${summary.crowdSize} agents, the order ${spec.agents}`;
  if (summary.rounds > spec.rounds) return `the run played ${summary.rounds} rounds, the order ${spec.rounds}`;
  if (summary.status === "complete" && summary.rounds !== spec.rounds) {
    return `a complete run played ${summary.rounds} rounds, the order ${spec.rounds}`;
  }
  if ((spec.question?.resolvesAt ?? null) !== (summary.question?.resolvesAt ?? null)) return "the run's question is not the order's";
  const sorted = (rounds: number[]) => [...rounds].sort((a, b) => a - b).join();
  if (sorted(meta.eventRounds) !== sorted(spec.scenario.events.map((event) => event.round))) {
    return "the run has other events than the order";
  }
  const symbol = spec.scenario.market?.tokenSymbol;
  if (symbol && summary.market.symbol !== symbol) return `the run's token is ${summary.market.symbol}, the order ${symbol}`;
  if (spec.clone && (summary.personaMix.clone ?? 0) !== 1) return "the run has no clone in it";
  if (spec.mix) {
    for (const persona of PERSONAS) {
      if ((summary.personaMix[persona] ?? 0) !== (spec.mix[persona] ?? 0)) return `the persona mix is not the order's (${persona})`;
    }
  }
  return null;
}

function completeAnswer(runId: string, hash: string, row: RunRow | null) {
  return { runId, hash, publishedAt: row?.published_at ?? null };
}
