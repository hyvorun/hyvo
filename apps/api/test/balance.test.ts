/** API keys and prepaid balances: a bot pays for a run from what the wallet topped up, and money never goes astray. */
import { BalanceResponse, CreateKeyResponse, CreateRunResponse, KeyListResponse, RunResponse, TopUpCheckResponse, TopUpResponse } from "@hyvo/schema";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { runScheduled } from "../src/scheduled";
import { account, ADDRESSES, call, chainEnv, FakeChain, frozenClock, json, KEYS, resetDb, runner, scenario, signIn } from "./helpers";

const NOW = 1_800_000_000;
const payer = account(KEYS.user).address;
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let session: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  target = chainEnv({ DAILY_SPEND_CAP_USD: "10", USDG_ADDRESS: ADDRESSES.usdg } as Partial<Env>);
  session = await signIn(target, KEYS.user, NOW);
  await runScheduled(target, NOW); // the first scan sets the payment cursor at the chain's head
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

async function newKey(as = session, label?: string): Promise<{ header: Record<string, string>; key: string; id: string }> {
  const response = await json(target, "/v1/keys", label ? { label } : {}, as);
  expect(response.status).toBe(201);
  const { key, apiKey } = CreateKeyResponse.parse(await response.json());
  return { header: { Authorization: `Bearer ${key}` }, key, id: apiKey.id };
}

async function balance(as: Record<string, string>) {
  const response = await call(target, "/v1/balance", { headers: as });
  expect(response.status).toBe(200);
  return BalanceResponse.parse(await response.json());
}

async function topUp(amountUsd: number, as = session) {
  const response = await json(target, "/v1/balance/topups", { amountUsd }, as);
  expect(response.status).toBe(201);
  return TopUpResponse.parse(await response.json()).topUp;
}

/** A top-up paid on chain and found by the cron. */
async function funded(amountUsd: number, as = session) {
  const order = await topUp(amountUsd, as);
  chain.pay(order.orderId, payer, ADDRESSES.usdg, BigInt(order.amount));
  chain.mine(5);
  await runScheduled(target, clock.now());
  return order;
}

function prepaid(body: Record<string, unknown>, as: Record<string, string>) {
  return json(target, "/v1/runs", { balance: true, scenario, agents: 50, rounds: 10, ...body }, as);
}

describe("API keys", () => {
  it("are made with a signed-in wallet, and a key cannot make more keys", async () => {
    expect((await json(target, "/v1/keys", {}, {})).status).toBe(401);
    const { header } = await newKey();
    expect((await json(target, "/v1/keys", {}, header)).status).toBe(401);
    expect((await call(target, "/v1/keys", { headers: header })).status).toBe(401);
  });

  it("are shown once, and only their hash is stored", async () => {
    const { key, id } = await newKey(session, "my bot");
    const stored = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(JSON.stringify(stored)).not.toContain(key);
    const { keys } = KeyListResponse.parse(await (await call(target, "/v1/keys", { headers: session })).json());
    expect(keys).toEqual([expect.objectContaining({ id, label: "my bot", prefix: key.slice(0, 12), lastUsedAt: null })]);
    expect(JSON.stringify(keys)).not.toContain(key);
  });

  it("work like a session for what spends the balance, and stop when revoked", async () => {
    const { header, id } = await newKey();
    expect((await balance(header)).address).toBe(payer);
    const [row] = (await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").bind(id).all<{ last_used_at: number }>()).results;
    expect(row?.last_used_at).toBe(NOW);
    expect((await call(target, `/v1/keys/${id}`, { method: "DELETE", headers: session })).status).toBe(200);
    expect((await call(target, "/v1/balance", { headers: header })).status).toBe(401);
    expect((await call(target, `/v1/keys/${id}`, { method: "DELETE", headers: session })).status).toBe(404);
  });

  it("belong to one wallet: another cannot see or revoke them", async () => {
    const { id } = await newKey();
    const other = await signIn(target, KEYS.other, NOW);
    expect((await call(target, `/v1/keys/${id}`, { method: "DELETE", headers: other })).status).toBe(404);
    expect(KeyListResponse.parse(await (await call(target, "/v1/keys", { headers: other })).json()).keys).toEqual([]);
  });

  it("are limited per wallet", async () => {
    for (let i = 0; i < 10; i++) await newKey();
    clock.advance(60);
    const response = await json(target, "/v1/keys", {}, session);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("too_many_keys");
  });
});

describe("top-ups", () => {
  it("are paid through PaymentRouter and credit the wallet that asked, whoever pays", async () => {
    const order = await topUp(5);
    expect(order).toMatchObject({ status: "quoted", amount: "5000000", amountUsd: 5, address: payer, creditedUsd: null });
    expect(order.paymentRouter).toBe("0x00000000000000000000000000000000000000A1");
    expect((await balance(session)).balanceUsd).toBe(0);
    chain.pay(order.orderId, account(KEYS.other).address, ADDRESSES.usdg, 5_000_000n);
    chain.mine(5);
    await runScheduled(target, clock.now());
    const after = await balance(session);
    expect(after.balanceUsd).toBe(5);
    expect(after.entries).toEqual([expect.objectContaining({ deltaUsd: 5, reason: "topup", runId: null })]);
  });

  it("can be checked at once by transaction hash, once", async () => {
    const order = await topUp(2);
    const tx = chain.pay(order.orderId, payer, ADDRESSES.usdg, 2_000_000n);
    chain.mine(5);
    const check = async () => {
      const response = await json(target, `/v1/balance/topups/${order.orderId}/payment`, { txHash: tx }, session);
      expect(response.status).toBe(200);
      return TopUpCheckResponse.parse(await response.json());
    };
    const first = await check();
    expect(first.check).toBe("paid");
    expect(first.message).toContain("balance");
    expect(first.topUp).toMatchObject({ status: "paid", creditedUsd: 2 });
    await check();
    await runScheduled(target, clock.now());
    expect((await balance(session)).balanceUsd).toBe(2);
    expect((await balance(session)).entries).toHaveLength(1);
  });

  it("credit what arrived, also when it is late or a different amount", async () => {
    const order = await topUp(2);
    clock.advance(86_400);
    chain.pay(order.orderId, payer, ADDRESSES.usdg, 3_500_000n);
    chain.mine(5);
    await runScheduled(target, clock.now());
    expect((await balance(session)).balanceUsd).toBe(3.5);
  });

  it("paid with another token credit nothing, and a refund is due", async () => {
    const order = await topUp(2);
    chain.pay(order.orderId, payer, ADDRESSES.other, 2_000_000n);
    chain.mine(5);
    await runScheduled(target, clock.now());
    expect((await balance(session)).balanceUsd).toBe(0);
    const refund = await env.DB.prepare("SELECT reason, amount FROM refunds").first();
    expect(refund).toEqual({ reason: "payment_unmatched", amount: "2000000" });
  });

  it("stay inside their range and need payments on", async () => {
    expect((await json(target, "/v1/balance/topups", { amountUsd: 0.5 }, session)).status).toBe(400);
    expect((await json(target, "/v1/balance/topups", { amountUsd: 501 }, session)).status).toBe(400);
    expect((await json(target, "/v1/balance/topups", { amountUsd: 1.234 }, session)).status).toBe(400);
    const off = chainEnv({ PAYMENT_ROUTER_ADDRESS: "" } as Partial<Env>);
    const answer = await json(off, "/v1/balance/topups", { amountUsd: 5 }, await signIn(off, KEYS.other, NOW));
    expect(answer.status).toBe(503);
  });

  it("are the asking wallet's only", async () => {
    const order = await topUp(2);
    const other = await signIn(target, KEYS.other, NOW);
    expect((await call(target, `/v1/balance/topups/${order.orderId}`, { headers: other })).status).toBe(404);
    expect((await call(target, `/v1/balance/topups/${order.orderId}`, { headers: session })).status).toBe(200);
  });
});

describe("runs paid from a balance", () => {
  it("debit the price in the same step and join the queue", async () => {
    const { header } = await newKey();
    await funded(5);
    const response = await prepaid({}, header);
    expect(response.status).toBe(201);
    const created = CreateRunResponse.parse(await response.json());
    expect(created.chargedUsd).toBe(1);
    expect(created.job.status).toBe("queued");
    const after = await balance(header);
    expect(after.balanceUsd).toBe(4);
    expect(after.entries[0]).toMatchObject({ deltaUsd: -1, reason: "run", runId: created.runId });
    const next = await runner(target, "/internal/jobs/next");
    expect(((await next.json()) as { job: { runId: string } }).job.runId).toBe(created.runId);
  });

  it("are refused when the balance is short, with nothing taken and nothing queued", async () => {
    await funded(1);
    const big = await prepaid({ agents: 500, rounds: 20 }, session);
    expect(big.status).toBe(402);
    expect(await big.text()).toContain("insufficient_balance");
    expect((await balance(session)).balanceUsd).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({ n: 0 });
  });

  it("cannot be paid twice from the same dollar", async () => {
    await funded(1);
    const answers = await Promise.all([prepaid({}, session), prepaid({}, session), prepaid({}, session)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 402, 402]);
    expect((await balance(session)).balanceUsd).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({ n: 1 });
  });

  it("pay once when a bot retries with its request id", async () => {
    await funded(5);
    const first = await prepaid({ requestId: "bot-attempt-1" }, session);
    const again = await prepaid({ requestId: "bot-attempt-1" }, session);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const a = CreateRunResponse.parse(await first.json());
    const b = CreateRunResponse.parse(await again.json());
    expect(b.runId).toBe(a.runId);
    expect(b.chargedUsd).toBe(1);
    expect((await balance(session)).balanceUsd).toBe(4);
  });

  it("use their request id per wallet", async () => {
    await funded(5);
    const other = await signIn(target, KEYS.other, NOW);
    expect((await prepaid({ requestId: "bot-attempt-1" }, session)).status).toBe(201);
    expect((await prepaid({ requestId: "bot-attempt-1" }, other)).status).toBe(402);
  });

  it("go back to the balance when the run fails twice, once", async () => {
    await funded(5);
    const { runId } = CreateRunResponse.parse(await (await prepaid({}, session)).json());
    const claim = async () => ((await (await runner(target, "/internal/jobs/next")).json()) as { job: { leaseId: string } }).job;
    const first = await claim();
    await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: first.leaseId, reason: "boom" });
    expect((await balance(session)).balanceUsd).toBe(4);
    const second = await claim();
    await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: second.leaseId, reason: "boom" });
    const after = await balance(session);
    expect(after.balanceUsd).toBe(5);
    expect(after.entries[0]).toMatchObject({ deltaUsd: 1, reason: "run_failed", runId });
    const status = RunResponse.parse(await (await call(target, `/v1/runs/${runId}`)).json());
    expect(status.job).toMatchObject({ status: "failed", refund: "credited" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refunds").first()).toEqual({ n: 0 });
  });

  it("go back when the runner goes quiet twice", async () => {
    await funded(5);
    const { runId } = CreateRunResponse.parse(await (await prepaid({}, session)).json());
    await runner(target, "/internal/jobs/next");
    clock.advance(91);
    await runner(target, "/internal/jobs/next");
    clock.advance(91);
    await runScheduled(target, clock.now());
    expect((await balance(session)).balanceUsd).toBe(5);
    expect(RunResponse.parse(await (await call(target, `/v1/runs/${runId}`)).json()).job?.refund).toBe("credited");
  });

  it("check their size like any run", async () => {
    await funded(5);
    expect((await prepaid({ agents: 5 }, session)).status).toBe(400);
    expect((await prepaid({ rounds: 2 }, session)).status).toBe(400);
    expect((await balance(session)).balanceUsd).toBe(5);
  });
});

describe("keys for paid orders", () => {
  it("can quote a run too", async () => {
    const { header } = await newKey();
    const response = await json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10 }, header);
    expect(response.status).toBe(201);
  });
});
