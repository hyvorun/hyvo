import { DISCLAIMER } from "@hyvo/schema";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireSession } from "../lib/auth";
import { cloneView, findClone } from "../lib/clones";
import { nowS } from "../lib/clock";
import { config } from "../lib/config";
import { ApiError } from "../lib/errors";
import { newRunId } from "../lib/ids";
import { rateLimit } from "../lib/ratelimit";

const BUILDS_PER_HOUR = 3;
const BUILD_TIMEOUT_S = 600;

/**
 * `/v1/clones/me`: Wallet Clone (SPEC 11.3). A session only, never an API key: a signature in this session is what proves the wallet is yours, and
 * only that wallet's address reaches the runner. There is no way to name another wallet.
 */
export const clones = new Hono<AppEnv>();

clones.use("*", requireSession);

clones.get("/me", async (c) => {
  const row = await findClone(c.env.DB, c.get("address"));
  return c.json({ clone: row ? cloneView(row) : null, open: config(c.env).features.clone, disclaimer: DISCLAIMER });
});

clones.post("/me", async (c) => {
  const db = c.env.DB;
  if (!config(c.env).features.clone) throw new ApiError(503, "clones_closed", "clones are not open yet");
  const signedIn = c.get("address");
  const address = signedIn.toLowerCase();
  const now = nowS();
  const current = await findClone(db, address);
  if (current?.status === "building") return c.json({ clone: cloneView(current), open: true, disclaimer: DISCLAIMER });
  await rateLimit(db, "clone", address, BUILDS_PER_HOUR, 3600, now);
  const runId = newRunId(now * 1000);
  await db.batch([
    db
      .prepare(
        `INSERT INTO jobs (run_id, order_id, address, source, kind, spec_json, title, listed, priority, status, rounds, max_cost_usd, timeout_s, created_at)
         VALUES (?, NULL, ?, 'clone', 'clone', ?, 'Wallet clone', 0, 0, 'queued', 1, 0, ?, ?)`,
      )
      .bind(runId, address, JSON.stringify({ address: signedIn }), BUILD_TIMEOUT_S, now),
    db
      .prepare(
        `INSERT INTO clones (address, status, run_id, created_at, updated_at) VALUES (?, 'building', ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET status = 'building', error = NULL, run_id = excluded.run_id, updated_at = excluded.updated_at`,
      )
      .bind(address, runId, now, now),
  ]);
  return c.json({ clone: cloneView((await findClone(db, address))!), open: true, disclaimer: DISCLAIMER }, 201);
});

/** Delete on request: the numbers, the jobs that built them, and every copy in a run's order. A published run keeps only its agent's actions. */
clones.delete("/me", async (c) => {
  const db = c.env.DB;
  const address = c.get("address").toLowerCase();
  await db.batch([
    db.prepare("DELETE FROM clones WHERE address = ?").bind(address),
    db.prepare("DELETE FROM jobs WHERE kind = 'clone' AND address = ?").bind(address),
    db
      .prepare("UPDATE jobs SET spec_json = json_remove(spec_json, '$.clone') WHERE kind = 'run' AND address = ? AND json_extract(spec_json, '$.clone') IS NOT NULL")
      .bind(address),
  ]);
  return c.body(null, 204);
});
