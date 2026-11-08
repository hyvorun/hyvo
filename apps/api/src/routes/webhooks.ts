import { CreateWebhookRequest, type WebhookDeliveryView, type WebhookEventType, type WebhookView } from "@hyvo/schema";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAccount } from "../lib/auth";
import { iso, isoOrNull, nowS } from "../lib/clock";
import { config } from "../lib/config";
import { ApiError, readJson } from "../lib/errors";
import { newId } from "../lib/ids";
import { rateLimit } from "../lib/ratelimit";
import { webhookSecret } from "../lib/signing";
import { webhookUrlProblem } from "../lib/webhooks";

const MAX_WEBHOOKS = 5;
const DELIVERIES_SHOWN = 20;

/** `/v1/webhooks`: a wallet's webhooks. The signing secret is shown once, when one is made. */
export const webhooks = new Hono<AppEnv>();

webhooks.use("*", requireAccount);

interface Row {
  id: string;
  url: string;
  events: string;
  created_at: number;
  disabled_at: number | null;
  failed_in_a_row: number;
}

function view(row: Row): WebhookView {
  return {
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as WebhookEventType[],
    createdAt: iso(row.created_at),
    disabledAt: isoOrNull(row.disabled_at),
    failedInARow: row.failed_in_a_row,
  };
}

webhooks.post("/", async (c) => {
  const db = c.env.DB;
  const now = nowS();
  const address = c.get("address").toLowerCase();
  await rateLimit(db, "webhook", address, 10, 60, now);
  const { url, events } = await readJson(c, CreateWebhookRequest);
  const problem = webhookUrlProblem(url, config(c.env).webOrigin.startsWith("http://localhost"));
  if (problem) throw new ApiError(400, "bad_request", problem);
  const active = await db
    .prepare("SELECT COUNT(*) AS n FROM webhooks WHERE address = ? AND disabled_at IS NULL")
    .bind(address)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_WEBHOOKS) {
    throw new ApiError(400, "too_many_webhooks", `a wallet can have ${MAX_WEBHOOKS} webhooks; delete one first`);
  }
  const row: Row = { id: newId("wh"), url, events: JSON.stringify([...new Set(events)]), created_at: now, disabled_at: null, failed_in_a_row: 0 };
  await db
    .prepare("INSERT INTO webhooks (id, address, url, events, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, address, row.url, row.events, now)
    .run();
  return c.json({ webhook: view(row), secret: await webhookSecret(c.env.ARTIFACT_SIGNING_KEY, row.id) }, 201);
});

webhooks.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, url, events, created_at, disabled_at, failed_in_a_row FROM webhooks WHERE address = ? ORDER BY created_at DESC LIMIT 20",
  )
    .bind(c.get("address").toLowerCase())
    .all<Row>();
  return c.json({ webhooks: rows.results.map(view) });
});

webhooks.delete("/:id", async (c) => {
  const db = c.env.DB;
  const done = await db
    .prepare("UPDATE webhooks SET disabled_at = ? WHERE id = ? AND address = ? AND disabled_at IS NULL")
    .bind(nowS(), c.req.param("id"), c.get("address").toLowerCase())
    .run();
  // Another wallet's webhook answers like a missing one.
  if (done.meta.changes === 0) throw new ApiError(404, "not_found", "unknown webhook");
  await db.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook deleted' WHERE webhook_id = ? AND status = 'pending'").bind(c.req.param("id")).run();
  return c.json({ ok: true as const });
});

/** The last deliveries of a webhook, for finding out why a receiver hears nothing. */
webhooks.get("/:id/deliveries", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const own = await db.prepare("SELECT 1 FROM webhooks WHERE id = ? AND address = ?").bind(id, c.get("address").toLowerCase()).first();
  if (!own) throw new ApiError(404, "not_found", "unknown webhook");
  const rows = await db
    .prepare(
      `SELECT id, type, status, attempts, next_at, last_error, created_at, delivered_at FROM webhook_deliveries
       WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .bind(id, DELIVERIES_SHOWN)
    .all<{
      id: string;
      type: WebhookEventType;
      status: "pending" | "delivered" | "failed";
      attempts: number;
      next_at: number;
      last_error: string | null;
      created_at: number;
      delivered_at: number | null;
    }>();
  const deliveries: WebhookDeliveryView[] = rows.results.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.status === "pending" ? iso(row.next_at) : null,
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    deliveredAt: isoOrNull(row.delivered_at),
  }));
  return c.json({ deliveries });
});
