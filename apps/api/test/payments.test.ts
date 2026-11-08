import { AdminOverviewResponse, OrderResponse, PaymentCheckResponse, RunResponse } from "@hyvo/schema";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { config } from "../src/lib/config";
import { jobTimeoutFor, maxDecisions } from "../src/lib/pricing";
import { runScheduled } from "../src/scheduled";
import {
  account,
  ADDRESSES,
  call,
  chainEnv,
  FakeChain,
  frozenClock,
  json,
  KEYS,
  resetDb,
  scenario,
  signIn,
} from "./helpers";

const NOW = 1_800_000_000;
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let headers: Record<string, string>;
const payer = account(KEYS.user).address;

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  target = chainEnv();
  headers = await signIn(target, KEYS.user, NOW);
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

async function quote(body: Record<string, unknown> = {}, as = headers) {
  return json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10, ...body }, as);
}

async function order(body: Record<string, unknown> = {}) {
  const response = await quote(body);
  expect(response.status).toBe(201);
  return OrderResponse.parse(await response.json()).order;
}

async function check(orderId: string, txHash: string) {
  const response = await json(target, `/v1/orders/${orderId}/payment`, { txHash }, headers);
  expect(response.status).toBe(200);
  return PaymentCheckResponse.parse(await response.json());
}

describe("quotes", () => {
  it("needs a session", async () => {
    expect((await quote({}, {})).status).toBe(401);
  });

  it("prices a run with the configured formula", async () => {
    // 50 x 10 x 0.0003 + 0.02 = 0.17; x 2.5 = 0.425 -> $1 (step and floor); budget 0.34.
    const small = await order();
    expect(small).toMatchObject({
      status: "quoted",
      address: payer,
      amount: "1000000",
      priceUsd: 1,
      estimatedCostUsd: 0.17,
      discountBps: 0,
      chainId: 4663,
      paymentRouter: "0x00000000000000000000000000000000000000A1",
      runId: null,
      run: { title: scenario.title, agents: 50, rounds: 10, listed: true },
    });
    expect(small.token).toEqual({ address: ADDRESSES.usdg, symbol: "USDG", decimals: 6 });
    expect(Date.parse(small.expiresAt) / 1000).toBe(NOW + 1800);
    // 500 x 20 x 0.0003 + 0.02 = 3.02; x 2.5 = 7.55 -> $8.
    const large = await order({ agents: 500, rounds: 20 });
    expect(large).toMatchObject({ priceUsd: 8, amount: "8000000", estimatedCostUsd: 3.02 });
    const stored = await env.DB.prepare("SELECT spec_json FROM orders WHERE order_id = ?").bind(large.orderId).first<{ spec_json: string }>();
    expect(JSON.parse(stored!.spec_json)).toMatchObject({
      version: 1,
      agents: 500,
      rounds: 20,
      batchSize: 10,
      maxCostUsd: 6.04,
      maxLlmCalls: (50 * 20 + 3) * 2,
      seed: null,
      mix: null,
    });
  });

  it("gives eligible holders the discount and priority", async () => {
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 10n ** 22n });
    const discounted = await order({ agents: 500, rounds: 20 });
    // 7.55 x 0.8 = 6.04 -> $7.
    expect(discounted).toMatchObject({ priceUsd: 7, discountBps: 2000 });
  });

  it.each([
    [{ agents: 9 }, "agents must be from 10 to 2000"],
    [{ agents: 2001 }, "agents must be from 10 to 2000"],
    [{ agents: 1000, rounds: 16 }, "agents x rounds must be at most 15000"],
    [{ rounds: 31 }, "rounds must be from 3 to 30"],
    [{ rounds: 2 }, "after the last round"],
    [{ scenario: { ...scenario, title: "" } }, "scenario.title"],
    [{ mix: { sniper: 10 } }, "mix"],
  ])("refuses %j", async (body, message) => {
    const response = await quote(body);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(message);
  });

  it("is off without payment config", async () => {
    target = chainEnv({ PAYMENT_ROUTER_ADDRESS: "" });
    const response = await json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10 }, await signIn(target, KEYS.user, NOW));
    expect(response.status).toBe(503);
  });

  it("shows an order only to its wallet, and expires it", async () => {
    const mine = await order();
    const other = await signIn(target, KEYS.other, NOW);
    expect((await call(target, `/v1/orders/${mine.orderId}`, { headers: other })).status).toBe(404);
    clock.advance(1801);
    const later = OrderResponse.parse(await (await call(target, `/v1/orders/${mine.orderId}`, { headers })).json());
    expect(later.order.status).toBe("expired");
    const list = (await (await call(target, "/v1/orders", { headers })).json()) as { orders: unknown[] };
    expect(list.orders).toHaveLength(1);
  });
});

describe("payment by transaction hash", () => {
  it("marks the order paid and queues its run", async () => {
    const o = await order({ listed: false });
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1_000_000n);
    chain.mine(2);
    const result = await check(o.orderId, tx);
    expect(result.check).toBe("paid");
    expect(result.order.status).toBe("paid");
    const runId = result.order.runId!;
    const status = RunResponse.parse(await (await call(target, `/v1/runs/${runId}`)).json());
    expect(status.run).toBeNull();
    expect(status.job).toMatchObject({ status: "queued", attempt: 0, progress: null, refund: null });
    // Asking again changes nothing.
    expect((await check(o.orderId, tx)).order.runId).toBe(runId);
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs!.n).toBe(1);
    // POST /v1/runs with the order answers with the same run.
    const created = await json(target, "/v1/runs", { orderId: o.orderId }, headers);
    expect(((await created.json()) as { runId: string }).runId).toBe(runId);
  });

  it("waits for confirmations, and reports unknown or reverted transactions", async () => {
    const o = await order();
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1_000_000n);
    expect((await check(o.orderId, tx)).check).toBe("pending");
    chain.mine(2);
    expect((await check(o.orderId, `0x${"ab".repeat(32)}`)).check).toBe("not_found");
    const reverted = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1_000_000n, { reverted: true });
    chain.mine(2);
    expect((await check(o.orderId, reverted)).check).toBe("failed");
    expect((await check(o.orderId, tx)).check).toBe("paid");
  });

  it.each([
    ["an underpayment", { amount: 999_999n }],
    ["another token", { token: ADDRESSES.other }],
    ["a payment after the quote expired", { late: true }],
  ])("refunds %s instead of running", async (_name, change: { amount?: bigint; token?: string; late?: boolean }) => {
    const o = await order();
    if (change.late) clock.advance(1800 + 301);
    const tx = chain.pay(o.orderId, payer, change.token ?? ADDRESSES.usdg, change.amount ?? 1_000_000n);
    chain.mine(2);
    const result = await check(o.orderId, tx);
    expect(result.check).toBe("mismatch");
    expect(result.order.runId).toBeNull();
    const refund = await env.DB.prepare("SELECT * FROM refunds").first<{ reason: string; address: string; amount: string }>();
    expect(refund).toMatchObject({ reason: "payment_unmatched", address: payer.toLowerCase() });
  });

  it("runs an overpaid order and refunds the excess", async () => {
    const o = await order();
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1_500_000n);
    chain.mine(2);
    expect((await check(o.orderId, tx)).check).toBe("paid");
    const refund = await env.DB.prepare("SELECT reason, amount FROM refunds").first();
    expect(refund).toEqual({ reason: "overpaid", amount: "500000" });
  });

  it("accepts a payment a little after expiry (wallet delays)", async () => {
    const o = await order();
    clock.advance(1800 + 120);
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1_000_000n);
    chain.mine(2);
    expect((await check(o.orderId, tx)).check).toBe("paid");
  });
});

describe("payment scan (cron)", () => {
  it("finds payments in new blocks, once", async () => {
    const o = await order();
    await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('payments.next_block', ?)").bind(String(chain.block)).run();
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1_000_000n);
    chain.pay(`0x${"cd".repeat(32)}`, payer, ADDRESSES.usdg, 2_000_000n); // no such order
    chain.mine(5);
    const report = await runScheduled(target, clock.now());
    expect(report.payments).toMatchObject({ payments: 2 });
    const paid = OrderResponse.parse(await (await call(target, `/v1/orders/${o.orderId}`, { headers })).json());
    expect(paid.order.status).toBe("paid");

    // A second scan and the user's own check find nothing new.
    await runScheduled(target, clock.now());
    expect((await check(o.orderId, tx)).check).toBe("paid");
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM refunds) AS refunds",
    ).first();
    expect(counts).toEqual({ jobs: 1, payments: 2, refunds: 1 });

    const admin = await signIn(target, KEYS.admin, NOW);
    const overview = AdminOverviewResponse.parse(await (await call(target, "/v1/admin/overview", { headers: admin })).json());
    expect(overview.fees).toEqual({ todayUsd: 1, last30dUsd: 1, paymentsLast30d: 1 });
    expect(overview.refunds).toHaveLength(1);
    expect(overview.refunds[0]).toMatchObject({ reason: "payment_unmatched", amount: "2000000", status: "due" });
    expect(overview.queue).toMatchObject({ queued: 1, running: 0, paused: false, dailyCapUsd: 20 });
  });

  it("scans at most LOG_RANGES_PER_RUN ranges and keeps its place", async () => {
    await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('payments.next_block', ?)").bind(String(chain.block)).run();
    const start = chain.block;
    chain.mine(200);
    const first = await runScheduled(target, clock.now());
    expect(first.payments).toMatchObject({ from: start.toString(), to: (start + 49n).toString() });
    const second = await runScheduled(target, clock.now());
    expect(second.payments).toMatchObject({ from: (start + 50n).toString() });
  });
});

describe("a very large crowd", () => {
  it("gets the time it needs, and an ordinary run keeps the queue's limit", () => {
    const cfg = config(env as unknown as Env);
    expect(jobTimeoutFor(cfg, { agents: 50, rounds: 10 })).toBe(cfg.queue.jobTimeoutS);
    expect(jobTimeoutFor(cfg, { agents: 1000, rounds: 10 })).toBe(2000);
    expect(jobTimeoutFor(cfg, { agents: 1500, rounds: 10 })).toBe(3000);
  });

  it("is held to what fits in a run's file, whatever the budget allows", () => {
    const cfg = config({ ...env, DAILY_SPEND_CAP_USD: "1000" } as unknown as Env);
    expect(maxDecisions(cfg)).toBe(15_000);
  });
});

