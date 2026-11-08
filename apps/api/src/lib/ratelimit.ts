/**
 * Fixed-window rate limits in D1 for the write endpoints (per IP and per wallet). Read endpoints
 * are cacheable and are limited at the Cloudflare zone instead (docs/RUNBOOK.md).
 */
import type { Context } from "hono";
import { ApiError } from "./errors";

export async function rateLimit(
  db: D1Database,
  scope: string,
  who: string,
  limit: number,
  windowS: number,
  now: number,
): Promise<void> {
  const start = now - (now % windowS);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(`${scope}:${who.toLowerCase()}:${start}`, start)
    .first<{ count: number }>();
  if (row && row.count > limit) {
    const wait = start + windowS - now;
    throw new ApiError(429, "rate_limited", `too many requests; try again in ${wait} s`, wait);
  }
}

export function clientIp(c: Context): string {
  return c.req.header("CF-Connecting-IP") ?? "local";
}
