/**
 * Webhooks (SPEC 8.1, 11.2). An event writes one delivery per matching webhook; the cron sends a few each minute and tries a
 * failed one again with growing waits. A body is signed as `X-Hyvo-Signature: t=<unix>,v1=<hex>`, where v1 is the HMAC-SHA256 of
 * `<t>.<body>` under the webhook's secret. Delivery is at least once: a receiver uses `id` to drop a repeat.
 *
 * `run.completed` and `run.failed` go to the wallet that started the run. `run.published` and `oracle.committed` go to every
 * webhook that asked for them when the run is listed, and to its own wallet's when it is not.
 */
import { DISCLAIMER, type WebhookEvent, type WebhookEventType } from "@hyvo/schema";
import { iso } from "./clock";
import { newId } from "./ids";
import { webhookSecret, webhookSignature } from "./signing";

export const WEBHOOKS_PER_RUN = 5;
/** Waits after attempts 1, 2, ...; when they run out the delivery has failed. */
export const RETRY_WAITS_S = [60, 300, 1800, 7200, 43_200];
/** What a sender holds a delivery for: longer than the request it makes. */
const CLAIM_S = 120;
const TIMEOUT_MS = 5000;
export const DISABLE_AFTER_FAILURES = 20;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;

/** For tests. */
export function setWebhookFetch(next: Fetcher | null): void {
  fetcher = next;
}

interface Event {
  type: WebhookEventType;
  data: WebhookEvent["data"];
  /** The wallet the run belongs to, when it has one. */
  address: string | null;
  listed: boolean;
}

const OWNER_ONLY: ReadonlySet<WebhookEventType> = new Set(["run.completed", "run.failed"]);

/** Write the deliveries of one event. Nothing is written when no webhook wants it. */
export async function notify(db: D1Database, event: Event, now: number): Promise<void> {
  const id = newId("evt");
  const body: WebhookEvent = { id, type: event.type, createdAt: iso(now), data: event.data, disclaimer: DISCLAIMER };
  const toAll = !OWNER_ONLY.has(event.type) && event.listed;
  await db
    .prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, type, body, status, next_at, created_at)
       SELECT 'whd_' || lower(hex(randomblob(12))), w.id, ?, ?, 'pending', ?, ?
       FROM webhooks w
       WHERE w.disabled_at IS NULL AND w.events LIKE ? AND (w.address = ? OR ?)`,
    )
    .bind(event.type, JSON.stringify(body), now, now, `%"${event.type}"%`, event.address ?? "", toAll ? 1 : 0)
    .run();
}

interface DueRow {
  id: string;
  webhook_id: string;
  type: string;
  body: string;
  attempts: number;
  next_at: number;
  url: string;
}

/** Send what is due. One slow or dead receiver only costs its own timeout. */
export async function deliverWebhooks(db: D1Database, signingKey: string, now: number, limit = WEBHOOKS_PER_RUN): Promise<number> {
  const due = await db
    .prepare(
      `SELECT d.id, d.webhook_id, d.type, d.body, d.attempts, d.next_at, w.url
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'pending' AND d.next_at <= ? AND w.disabled_at IS NULL
       ORDER BY d.next_at LIMIT ?`,
    )
    .bind(now, limit)
    .all<DueRow>();
  let sent = 0;
  for (const row of due.results) {
    const claimed = await db
      .prepare("UPDATE webhook_deliveries SET next_at = ? WHERE id = ? AND status = 'pending' AND next_at = ?")
      .bind(now + CLAIM_S, row.id, row.next_at)
      .run();
    if (claimed.meta.changes === 0) continue;
    const problem = await send(row, signingKey, now);
    await record(db, row, problem, now);
    sent++;
  }
  return sent;
}

async function send(row: DueRow, signingKey: string, now: number): Promise<string | null> {
  const secret = await webhookSecret(signingKey, row.webhook_id);
  const signature = await webhookSignature(secret, now, row.body);
  try {
    const response = await (fetcher ?? fetch)(row.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Hyvo-Webhook/1",
        "X-Hyvo-Event": row.type,
        "X-Hyvo-Delivery": row.id,
        "X-Hyvo-Signature": signature,
      },
      body: row.body,
      // A redirect could point anywhere; the receiver registered this URL.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return String((error as Error)?.name ?? error).slice(0, 100);
  }
}

async function record(db: D1Database, row: DueRow, problem: string | null, now: number): Promise<void> {
  const attempts = row.attempts + 1;
  if (!problem) {
    await db.batch([
      db
        .prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, delivered_at = ?, last_error = NULL WHERE id = ?")
        .bind(attempts, now, row.id),
      db.prepare("UPDATE webhooks SET failed_in_a_row = 0 WHERE id = ?").bind(row.webhook_id),
    ]);
    return;
  }
  const wait = RETRY_WAITS_S[attempts - 1];
  if (wait !== undefined) {
    await db
      .prepare("UPDATE webhook_deliveries SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?")
      .bind(attempts, now + wait, problem, row.id)
      .run();
    return;
  }
  await db.batch([
    db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").bind(attempts, problem, row.id),
    db.prepare("UPDATE webhooks SET failed_in_a_row = failed_in_a_row + 1 WHERE id = ?").bind(row.webhook_id),
    db
      .prepare("UPDATE webhooks SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL AND failed_in_a_row >= ?")
      .bind(now, row.webhook_id, DISABLE_AFTER_FAILURES),
  ]);
}

const PRIVATE_HOST = /(^localhost$)|(\.localhost$)|(\.local$)|(\.internal$)|(\.arpa$)|(^\[)|(^[0-9.]+$)|(^0x)/i;

/** Why a URL cannot be a webhook, or null. `allowLocal` is for a local stack only. */
export function webhookUrlProblem(raw: string, allowLocal: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the URL is not valid";
  }
  if (allowLocal && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return null;
  if (url.protocol !== "https:") return "the URL must use https";
  if (url.username || url.password) return "the URL must not carry a user or a password";
  if (!url.hostname.includes(".") || PRIVATE_HOST.test(url.hostname)) return "the URL must name a public host, not an address";
  return null;
}
