import { CreateKeyRequest, PaymentCheckRequest, TopUpRequest, type ApiKeyView, type BalanceEntry } from "@hyvo/schema";
import { Hono } from "hono";
import { getAddress, type Hex } from "viem";
import type { AppEnv } from "../env";
import { API_KEY_PREFIX, requireAccount, requireSession } from "../lib/auth";
import { balanceOf, createTopUp, findTopUp, toUsd, topUpView, type BalanceReason, type TopUpRow } from "../lib/balance";
import { iso, isoOrNull, nowS } from "../lib/clock";
import { config } from "../lib/config";
import { ApiError, readJson } from "../lib/errors";
import { newId, newToken, sha256Hex } from "../lib/ids";
import { checkPaymentTx } from "../lib/payments";
import { rateLimit } from "../lib/ratelimit";

const MAX_ACTIVE_KEYS = 10;
const ENTRIES_SHOWN = 50;

/**
 * `/v1/keys`: API keys for bots. Each spends its wallet's balance. Managing keys takes a signed-in session, so a key that
 * leaks cannot make more of itself; revoking one needs the wallet too.
 */
export const keys = new Hono<AppEnv>();

keys.use("*", requireSession);

interface KeyRow {
  id: string;
  prefix: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}

function keyView(row: KeyRow): ApiKeyView {
  return { id: row.id, label: row.label, prefix: row.prefix, createdAt: iso(row.created_at), lastUsedAt: isoOrNull(row.last_used_at) };
}

keys.post("/", async (c) => {
  const db = c.env.DB;
  const now = nowS();
  const address = c.get("address").toLowerCase();
  await rateLimit(db, "key-create", address, 10, 60, now);
  const { label } = await readJson(c, CreateKeyRequest);
  const active = await db
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE address = ? AND revoked_at IS NULL")
    .bind(address)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new ApiError(400, "too_many_keys", `a wallet can have ${MAX_ACTIVE_KEYS} active keys; revoke one first`);
  }
  const key = `${API_KEY_PREFIX}${newToken()}`;
  const row: KeyRow = { id: newId("key"), prefix: key.slice(0, 12), label: label ?? null, created_at: now, last_used_at: null };
  await db
    .prepare("INSERT INTO api_keys (id, key_hash, prefix, address, label, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, await sha256Hex(key), row.prefix, address, row.label, now)
    .run();
  return c.json({ key, apiKey: keyView(row) }, 201);
});

keys.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, prefix, label, created_at, last_used_at FROM api_keys WHERE address = ? AND revoked_at IS NULL ORDER BY created_at DESC",
  )
    .bind(c.get("address").toLowerCase())
    .all<KeyRow>();
  return c.json({ keys: rows.results.map(keyView) });
});

keys.delete("/:id", async (c) => {
  const done = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND address = ? AND revoked_at IS NULL")
    .bind(nowS(), c.req.param("id"), c.get("address").toLowerCase())
    .run();
  // Another wallet's key answers like a missing one.
  if (done.meta.changes === 0) throw new ApiError(404, "not_found", "unknown key");
  return c.json({ ok: true as const });
});

/** `/v1/balance`: the prepaid balance of a wallet, and top-ups through PaymentRouter. */
export const balance = new Hono<AppEnv>();

balance.use("*", requireAccount);

balance.get("/", async (c) => {
  const db = c.env.DB;
  const address = c.get("address");
  const entries = await db
    .prepare(
      "SELECT id, delta_micros, reason, run_id, created_at FROM balance_entries WHERE address = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .bind(address.toLowerCase(), ENTRIES_SHOWN)
    .all<{ id: string; delta_micros: number; reason: BalanceReason; run_id: string | null; created_at: number }>();
  const lines: BalanceEntry[] = entries.results.map((row) => ({
    id: row.id,
    deltaUsd: toUsd(row.delta_micros),
    reason: row.reason,
    runId: row.run_id,
    createdAt: iso(row.created_at),
  }));
  return c.json({ address: getAddress(address), balanceUsd: toUsd(await balanceOf(db, address)), entries: lines });
});

balance.post("/topups", async (c) => {
  const now = nowS();
  await rateLimit(c.env.DB, "topup", c.get("address"), 20, 60, now);
  const cfg = config(c.env);
  const { amountUsd } = await readJson(c, TopUpRequest);
  const row = await createTopUp(c.env.DB, cfg, c.get("address"), amountUsd, now);
  return c.json({ topUp: topUpView(cfg, row, now) }, 201);
});

balance.get("/topups/:orderId", async (c) => {
  const row = await ownTopUp(c.env.DB, c.req.param("orderId"), c.get("address"));
  return c.json({ topUp: topUpView(config(c.env), row, nowS()) });
});

/** Check a payment transaction now instead of waiting for the cron scan. */
balance.post("/topups/:orderId/payment", async (c) => {
  const cfg = config(c.env);
  const db = c.env.DB;
  const now = nowS();
  await rateLimit(db, "payment", c.get("address"), 30, 60, now);
  const row = await ownTopUp(db, c.req.param("orderId"), c.get("address"));
  if (!cfg.features.payments) throw new ApiError(503, "payments_disabled", "payments are not configured on this API");
  const { txHash } = await readJson(c, PaymentCheckRequest);
  const paid = "Payment confirmed. The balance is credited.";
  let result: Awaited<ReturnType<typeof checkPaymentTx>>;
  if (row.status === "paid") {
    result = { check: "paid", message: paid };
  } else {
    try {
      result = await checkPaymentTx(db, cfg, row.order_id, txHash as Hex, now, paid);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "payment_check_failed", error: String(error).slice(0, 300) }));
      throw new ApiError(503, "chain_unavailable", "The payment could not be checked right now. Try again shortly.", 10);
    }
  }
  return c.json({ topUp: topUpView(cfg, (await findTopUp(db, row.order_id))!, now), ...result });
});

async function ownTopUp(db: D1Database, orderId: string, address: string): Promise<TopUpRow> {
  const row = /^0x[0-9a-fA-F]{64}$/.test(orderId) ? await findTopUp(db, orderId) : null;
  if (!row || row.address !== address.toLowerCase()) throw new ApiError(404, "not_found", "unknown top-up");
  return row;
}
