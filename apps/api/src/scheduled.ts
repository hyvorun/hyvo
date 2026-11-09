/**
 * The cron (every minute, wrangler.jsonc `triggers.crons`): return quiet jobs to the queue, scan
 * new blocks for payments, send or confirm oracle commits, send webhooks and drop expired rows. One
 * failing step never blocks the others.
 */
import type { Env } from "./env";
import { config } from "./lib/config";
import { BLOCKSCOUT_DAY_SCOPE } from "./lib/holders";
import { sweepStale } from "./lib/jobs";
import { processCommits } from "./lib/oracle";
import { scanPayments } from "./lib/payments";
import { processResolutions } from "./lib/questions";
import { deliverWebhooks } from "./lib/webhooks";

export async function runScheduled(env: Env, now: number): Promise<Record<string, unknown>> {
  const cfg = config(env);
  const db = env.DB;
  const report: Record<string, unknown> = {};
  const step = async (name: string, work: () => Promise<unknown>) => {
    try {
      report[name] = await work();
    } catch (error) {
      report[name] = { error: String(error).slice(0, 300) };
      console.error(JSON.stringify({ level: "error", event: "cron_step_failed", step: name, error: String(error).slice(0, 300) }));
    }
  };
  await step("sweep", () => sweepStale(db, cfg, now));
  if (cfg.features.payments) await step("payments", () => scanPayments(db, cfg, now).then(stringify));
  if (cfg.features.oracle) {
    await step("oracle", () => processCommits(db, cfg, now));
    await step("questions", () => processResolutions(db, cfg, env.PUBLIC_API_URL, now));
  }
  await step("webhooks", () => deliverWebhooks(db, env.ARTIFACT_SIGNING_KEY, now));
  await step("cleanup", () =>
    db.batch([
      db.prepare("DELETE FROM siwe_nonces WHERE expires_at < ?").bind(now),
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      // Windows of an hour at most go an hour after they start; the Worker's day of Blockscout reads after its day.
      db.prepare("DELETE FROM rate_limits WHERE window_start < ? AND key NOT LIKE ?").bind(now - 3600, `${BLOCKSCOUT_DAY_SCOPE}:%`),
      db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 86_400),
    ]).then(() => "ok"),
  );
  return report;
}

function stringify(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, typeof v === "bigint" ? v.toString() : v]));
}
