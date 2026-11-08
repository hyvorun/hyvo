import { QueueRequest, RefundSentRequest, ResolveQuestionRequest, type AdminOverviewResponse, type RefundView } from "@hyvo/schema";
import { Hono } from "hono";
import { formatUnits, getAddress, type Hex } from "viem";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { iso, isoOrNull, nowS, startOfUtcDay } from "../lib/clock";
import { config, type Config } from "../lib/config";
import { getKv, setKv } from "../lib/db";
import { ApiError, readJson } from "../lib/errors";
import { inBackground } from "../lib/background";
import { QUEUE_PAUSED_KEY, spendToday } from "../lib/jobs";
import { decideQuestion, processResolution, questionsDue } from "../lib/questions";

/** `/v1/admin`: the founder's view of the queue, money and failures (SPEC 13). */
export const admin = new Hono<AppEnv>();

admin.use("*", requireAdmin);

interface RefundRow {
  id: string;
  reason: string;
  run_id: string | null;
  order_id: string | null;
  address: string;
  token: string;
  amount: string;
  status: "due" | "sent";
  tx_hash: string | null;
  note: string | null;
  created_at: number;
  sent_at: number | null;
}

admin.get("/overview", async (c) => {
  const cfg = config(c.env);
  const db = c.env.DB;
  const now = nowS();
  const day = startOfUtcDay(now);
  const count = (sql: string, ...args: unknown[]) =>
    db.prepare(sql).bind(...args).first<{ n: number }>().then((row) => row?.n ?? 0);

  const [paused, queued, running, spend, completeN, partialN, failedN, pending, failedCommits] = await Promise.all([
    getKv(db, QUEUE_PAUSED_KEY),
    count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"),
    count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'"),
    spendToday(db, now),
    count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'complete' AND run_status = 'complete' AND finished_at >= ?", now - 7 * 86_400),
    count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'complete' AND run_status = 'partial' AND finished_at >= ?", now - 7 * 86_400),
    count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND finished_at >= ?", now - 7 * 86_400),
    count("SELECT COUNT(*) AS n FROM oracle_commits WHERE status IN ('pending', 'sent')"),
    count("SELECT COUNT(*) AS n FROM oracle_commits WHERE status = 'failed'"),
  ]);

  // Fees: matched payments in USDG (a dollar stablecoin), by the event's time.
  const usdg = cfg.usdg;
  const paid = usdg
    ? await db
        .prepare("SELECT amount, paid_at FROM payments WHERE matched = 1 AND token = ? AND paid_at >= ?")
        .bind(usdg.address.toLowerCase(), now - 30 * 86_400)
        .all<{ amount: string; paid_at: number }>()
    : { results: [] };
  const usd = (rows: { amount: string }[]) =>
    usdg ? rows.reduce((sum, row) => sum + Number(formatUnits(BigInt(row.amount), usdg.decimals)), 0) : 0;

  const failures = await db
    .prepare(
      `SELECT j.run_id, j.finished_at, j.fail_reason, r.status AS refund FROM jobs j
       LEFT JOIN refunds r ON r.run_id = j.run_id AND r.reason = 'run_failed'
       WHERE j.status = 'failed' ORDER BY j.finished_at DESC LIMIT 20`,
    )
    .all<{ run_id: string; finished_at: number; fail_reason: string | null; refund: "due" | "sent" | null }>();
  const commitError = await db
    .prepare("SELECT error FROM oracle_commits WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1")
    .first<{ error: string | null }>();
  const refunds = await db
    .prepare(
      `SELECT * FROM refunds WHERE status = 'due' OR sent_at >= ?
       ORDER BY CASE status WHEN 'due' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`,
    )
    .bind(now - 30 * 86_400)
    .all<RefundRow>();

  const body: AdminOverviewResponse = {
    now: iso(now),
    features: cfg.features,
    queue: { paused: paused === "1", queued, running, spendTodayUsd: round2(spend), dailyCapUsd: cfg.queue.dailyCapUsd },
    fees: {
      todayUsd: round2(usd(paid.results.filter((row) => row.paid_at >= day))),
      last30dUsd: round2(usd(paid.results)),
      paymentsLast30d: paid.results.length,
    },
    jobs: { completeLast7d: completeN, partialLast7d: partialN, failedLast7d: failedN },
    failures: failures.results.map((row) => ({
      runId: row.run_id,
      failedAt: iso(row.finished_at),
      reason: row.fail_reason ?? "unknown",
      refund: row.refund,
    })),
    refunds: refunds.results.map((row) => refundView(cfg, row)),
    oracle: { pending, failed: failedCommits, lastError: commitError?.error ?? null },
    questionsDue: await questionsDue(db, now),
  };
  return c.json(body);
});

/** Record a refund sent by hand from the treasury (docs/RUNBOOK.md). */
admin.post("/refunds/:id", async (c) => {
  const body = await readJson(c, RefundSentRequest);
  const now = nowS();
  const row = await c.env.DB.prepare(
    `UPDATE refunds SET status = 'sent', tx_hash = ?, note = ?, sent_at = ? WHERE id = ? AND status = 'due' RETURNING *`,
  )
    .bind(body.txHash, body.note ?? null, now, c.req.param("id"))
    .first<RefundRow>();
  if (!row) throw new ApiError(404, "not_found", "no refund due with this id");
  console.log(JSON.stringify({ level: "info", event: "refund_recorded", id: row.id, by: c.get("address") }));
  return c.json({ refund: refundView(config(c.env), row) });
});

/** Record what happened to a question whose date has passed. It goes on-chain with the attester key, for good. */
admin.post("/questions/:runId/resolve", async (c) => {
  const body = await readJson(c, ResolveQuestionRequest);
  const now = nowS();
  const cfg = config(c.env);
  const runId = c.req.param("runId");
  const row = await decideQuestion(c.env.DB, runId, body, now);
  console.log(JSON.stringify({ level: "info", event: "question_decided", runId, outcome: body.outcome, by: c.get("address") }));
  if (cfg.features.oracle) inBackground(c, processResolution(c.env.DB, cfg, c.env.PUBLIC_API_URL || new URL(c.req.url).origin, runId, now));
  return c.json({ runId, outcome: row.outcome, outcomeHash: row.outcome_hash });
});

/** Pause or resume the queue (running jobs finish; nothing new is handed out). */
admin.post("/queue", async (c) => {
  const body = await readJson(c, QueueRequest);
  await setKv(c.env.DB, QUEUE_PAUSED_KEY, body.paused ? "1" : "0");
  console.log(JSON.stringify({ level: "info", event: "queue_paused", paused: body.paused, by: c.get("address") }));
  return c.json({ paused: body.paused });
});

function refundView(cfg: Config, row: RefundRow): RefundView {
  // A payment can arrive in any token the router allows; unknown ones are shown in base units.
  const token = [cfg.usdg, cfg.hyvoToken].find((known) => known?.address.toLowerCase() === row.token.toLowerCase());
  return {
    id: row.id,
    reason: row.reason,
    runId: row.run_id,
    orderId: (row.order_id as Hex | null) ?? null,
    address: getAddress(row.address),
    token: getAddress(row.token),
    symbol: token?.symbol ?? null,
    decimals: token?.decimals ?? null,
    amount: row.amount,
    status: row.status,
    txHash: (row.tx_hash as Hex | null) ?? null,
    note: row.note,
    createdAt: iso(row.created_at),
    sentAt: isoOrNull(row.sent_at),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
