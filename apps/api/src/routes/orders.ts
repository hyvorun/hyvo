import { PaymentCheckRequest, QuoteRequest, type JobSpec, type Order } from "@hyvo/schema";
import { Hono } from "hono";
import { getAddress, type Hex } from "viem";
import type { AppEnv } from "../env";
import { requireAccount } from "../lib/auth";
import { iso, isoOrNull, nowS } from "../lib/clock";
import { config, type Config } from "../lib/config";
import { ApiError, readJson } from "../lib/errors";
import { holderTerms } from "../lib/holder";
import { randomHex } from "../lib/ids";
import { checkPaymentTx, findOrder, type OrderRow } from "../lib/payments";
import { buildSpec, checkDailyCap, checkSize, quoteRun, tokenAmount } from "../lib/pricing";
import { checkQuestion } from "../lib/questions";
import { clientIp, rateLimit } from "../lib/ratelimit";

/** `/v1/quotes` and `/v1/orders`: price a run, then pay it through PaymentRouter. */
export const quotes = new Hono<AppEnv>();
export const orders = new Hono<AppEnv>();

quotes.use("*", requireAccount);
orders.use("*", requireAccount);

quotes.post("/", async (c) => {
  const cfg = config(c.env);
  const db = c.env.DB;
  const now = nowS();
  const address = c.get("address");
  await rateLimit(db, "quote", address, 20, 60, now);
  await rateLimit(db, "quote-ip", clientIp(c), 60, 60, now);
  const usdg = cfg.usdg;
  if (!cfg.features.payments || !usdg || !cfg.router) {
    throw new ApiError(503, "payments_disabled", "payments are not configured on this API");
  }
  const request = await readJson(c, QuoteRequest);
  return c.json({ order: await createOrder(db, cfg, address, request, now) }, 201);
});

/** Price a run and fix it as an order to pay through PaymentRouter. */
export async function createOrder(
  db: D1Database,
  cfg: Config,
  address: string,
  request: Parameters<typeof buildSpec>[1] & { listed?: boolean | undefined },
  now: number,
): Promise<Order> {
  const usdg = cfg.usdg;
  if (!cfg.features.payments || !usdg || !cfg.router) {
    throw new ApiError(503, "payments_disabled", "payments are not configured on this API");
  }
  checkSize(cfg, request);
  checkQuestion(cfg, request.question, now);
  const { discountBps, priority } = await holderTerms(db, cfg, address, now);
  const quote = quoteRun(cfg, request, discountBps);
  checkDailyCap(cfg, quote);
  const spec = buildSpec(cfg, request, quote);
  const orderId = randomHex(32);
  const amount = tokenAmount(usdg, quote.priceUsd);
  await db
    .prepare(
      `INSERT INTO orders (order_id, address, spec_json, title, listed, token, amount, price_usd, estimated_cost_usd,
                           discount_bps, priority, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)`,
    )
    .bind(
      orderId,
      address.toLowerCase(),
      JSON.stringify(spec),
      spec.scenario.title,
      request.listed === false ? 0 : 1,
      usdg.address.toLowerCase(),
      amount.toString(),
      quote.priceUsd,
      quote.estimatedCostUsd,
      quote.discountBps,
      priority,
      now,
      now + cfg.pricing.quoteTtlS,
    )
    .run();
  return orderView(cfg, (await findOrder(db, orderId))!, now);
}

orders.get("/", async (c) => {
  const cfg = config(c.env);
  const rows = await c.env.DB.prepare("SELECT * FROM orders WHERE address = ? ORDER BY created_at DESC LIMIT 20")
    .bind(c.get("address").toLowerCase())
    .all<OrderRow>();
  const now = nowS();
  return c.json({ orders: rows.results.map((row) => orderView(cfg, row, now)) });
});

orders.get("/:orderId", async (c) => {
  const order = await ownOrder(c.env.DB, c.req.param("orderId"), c.get("address"));
  return c.json({ order: orderView(config(c.env), order, nowS()) });
});

/** Check a payment transaction now instead of waiting for the cron scan. */
orders.post("/:orderId/payment", async (c) => {
  const cfg = config(c.env);
  const db = c.env.DB;
  const now = nowS();
  await rateLimit(db, "payment", c.get("address"), 30, 60, now);
  const order = await ownOrder(db, c.req.param("orderId"), c.get("address"));
  if (!cfg.features.payments) throw new ApiError(503, "payments_disabled", "payments are not configured on this API");
  const { txHash } = await readJson(c, PaymentCheckRequest);
  let result: Awaited<ReturnType<typeof checkPaymentTx>>;
  if (order.status === "paid") {
    result = { check: "paid", message: "Payment confirmed. The run is queued." };
  } else {
    try {
      result = await checkPaymentTx(db, cfg, order.order_id, txHash as Hex, now);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "payment_check_failed", error: String(error).slice(0, 300) }));
      throw new ApiError(503, "chain_unavailable", "The payment could not be checked right now. Try again shortly.", 10);
    }
  }
  const updated = (await findOrder(db, order.order_id))!;
  return c.json({ order: orderView(cfg, updated, now), ...result });
});

export async function ownOrder(db: D1Database, orderId: string, address: string): Promise<OrderRow> {
  const order = /^0x[0-9a-fA-F]{64}$/.test(orderId) ? await findOrder(db, orderId) : null;
  // Another wallet's order answers like a missing one.
  if (!order || order.address !== address.toLowerCase()) throw new ApiError(404, "not_found", "unknown order");
  return order;
}

export function orderView(cfg: Config, row: OrderRow, now: number): Order {
  const spec = JSON.parse(row.spec_json) as JobSpec;
  const token = cfg.usdg && cfg.usdg.address.toLowerCase() === row.token ? cfg.usdg : null;
  return {
    orderId: row.order_id as `0x${string}`,
    status: row.status === "paid" ? "paid" : now > row.expires_at ? "expired" : "quoted",
    address: getAddress(row.address),
    token: { address: getAddress(row.token), symbol: token?.symbol ?? "TOKEN", decimals: token?.decimals ?? 18 },
    amount: row.amount,
    priceUsd: row.price_usd,
    estimatedCostUsd: row.estimated_cost_usd,
    discountBps: row.discount_bps,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    paidAt: isoOrNull(row.paid_at),
    runId: row.run_id,
    chainId: cfg.chainId,
    paymentRouter: cfg.router ?? "0x0000000000000000000000000000000000000000",
    run: { title: row.title, agents: spec.agents, rounds: spec.rounds, listed: row.listed === 1 },
  };
}
