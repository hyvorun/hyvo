/**
 * Regressions from the Phase 3 review: money that must not get stuck when the database fails
 * midway, oracle commits that must not be sent twice or given up on, and runs that must be the job.
 */
import {
  AdminOverviewResponse,
  OrderResponse,
  RunnerJob,
  RunResponse,
  runIdToBytes32,
  type Order,
} from "@hyvo/schema";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { failAttempt, type JobRow } from "../src/lib/jobs";
import { processCommits } from "../src/lib/oracle";
import { config } from "../src/lib/config";
import { runScheduled } from "../src/scheduled";
import {
  account,
  ADDRESSES,
  call,
  chainEnv,
  FakeChain,
  flakyDb,
  frozenClock,
  json,
  KEYS,
  metaFor,
  resetDb,
  runFor,
  runner,
  scenario,
  signIn,
  type FlakyDb,
} from "./helpers";

const NOW = 1_800_000_000;
const payer = account(KEYS.user).address;
let flaky: FlakyDb;
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let user: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  flaky = flakyDb(env.DB);
  target = chainEnv({ DB: flaky });
  user = await signIn(target, KEYS.user, NOW);
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

async function order(body: Record<string, unknown> = {}): Promise<Order> {
  const quoted = await json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10, ...body }, user);
  expect(quoted.status).toBe(201);
  return OrderResponse.parse(await quoted.json()).order;
}

function payment(o: Order, txHash: string) {
  return json(target, `/v1/orders/${o.orderId}/payment`, { txHash }, user);
}

async function paidRun(): Promise<string> {
  const o = await order();
  const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, BigInt(o.amount));
  chain.mine(2);
  const checked = await payment(o, tx);
  return ((await checked.json()) as { order: { runId: string } }).order.runId;
}

async function claim(): Promise<RunnerJob> {
  const response = await runner(target, "/internal/jobs/next");
  expect(response.status).toBe(200);
  return RunnerJob.parse(((await response.json()) as { job: unknown }).job);
}

async function deliver(job: RunnerJob, body = runFor(job.runId)): Promise<Response> {
  const link = (await (await runner(target, `/internal/jobs/${job.runId}/upload-url`, { leaseId: job.leaseId })).json()) as {
    url: string;
  };
  const url = new URL(link.url);
  const put = await call(target, url.pathname + url.search, { method: "PUT", body });
  expect(put.status).toBe(200);
  return runner(target, `/internal/jobs/${job.runId}/complete`, { leaseId: job.leaseId, ...(await metaFor(body)) });
}

async function status(runId: string) {
  return RunResponse.parse(await (await call(target, `/v1/runs/${runId}`)).json());
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

describe("a database failure never strands a payment", () => {
  it("settles a matching payment on the next try", async () => {
    const o = await order();
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, BigInt(o.amount));
    chain.mine(2);
    flaky.failNextBatch();
    expect((await payment(o, tx)).status).toBeGreaterThanOrEqual(500);
    const retry = await payment(o, tx);
    expect(((await retry.json()) as { check: string }).check).toBe("paid");
    expect(await count("jobs")).toBe(1);
  });

  it("records the refund of an unmatched payment on the next try", async () => {
    const o = await order();
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1n);
    chain.mine(2);
    flaky.failNextBatch();
    expect((await payment(o, tx)).status).toBeGreaterThanOrEqual(500);
    await payment(o, tx);
    expect(await count("refunds")).toBe(1);
  });

  it("the scan does not move past a payment it could not settle", async () => {
    const o = await order();
    await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('payments.next_block', ?)").bind(String(chain.block)).run();
    chain.pay(o.orderId, payer, ADDRESSES.usdg, BigInt(o.amount));
    chain.mine(5);
    flaky.failNextBatch();
    const first = await runScheduled(target, clock.now());
    expect(first.payments).toHaveProperty("error");
    await runScheduled(target, clock.now());
    expect(await count("jobs")).toBe(1);
  });

  it("answers 503 when the chain cannot be read", async () => {
    const o = await order();
    chain.failReads = true;
    const response = await payment(o, `0x${"ab".repeat(32)}`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("chain_unavailable");
  });

  it("the scan waits on a chain younger than the confirmations", async () => {
    await order();
    chain.block = 1n;
    const report = await runScheduled(target, clock.now());
    expect(report.payments).not.toHaveProperty("error");
  });
});

describe("a failed run keeps its money straight", () => {
  it("records the failure and the refund together, or neither", async () => {
    const runId = await paidRun();
    const job = await claim();
    flaky.failNextBatch();
    const failed = await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: job.leaseId, reason: "x", retryable: false });
    expect(failed.status).toBe(500);
    expect((await status(runId)).job?.status).toBe("running");
    expect(await count("refunds")).toBe(0);
    await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: job.leaseId, reason: "x", retryable: false });
    expect((await status(runId)).job).toMatchObject({ status: "failed", refund: "due" });
  });

  it("never refunds an overpayment's excess twice", async () => {
    const o = await order();
    const tx = chain.pay(o.orderId, payer, ADDRESSES.usdg, 1_500_000n);
    chain.mine(2);
    const paid = (await (await payment(o, tx)).json()) as { order: { runId: string } };
    const job = await claim();
    await runner(target, `/internal/jobs/${paid.order.runId}/fail`, { leaseId: job.leaseId, reason: "x", retryable: false });
    const rows = await env.DB.prepare("SELECT reason, amount FROM refunds ORDER BY reason").all<{ reason: string; amount: string }>();
    expect(rows.results).toEqual([
      { reason: "overpaid", amount: "500000" },
      { reason: "run_failed", amount: "1000000" },
    ]);
  });

  it("gives a holder's credit back once, even if the failure is reported twice", async () => {
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 10n ** 22n });
    const free = { credit: true, scenario: { ...scenario, events: [] }, agents: 20, rounds: 5 };
    await json(target, "/v1/runs", free, user);
    await json(target, "/v1/runs", free, user);
    const job = await claim();
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ?").bind(job.runId).first<JobRow>();
    await failAttempt(env.DB, row!, "x", false, NOW);
    await failAttempt(env.DB, row!, "x", false, NOW);
    const usage = await env.DB.prepare("SELECT used FROM credit_usage").first<{ used: number }>();
    expect(usage!.used).toBe(1);
  });

  it("gives the credit back when the free run cannot be queued", async () => {
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 10n ** 22n });
    flaky.failNextPrepare(/INTO jobs/);
    const free = { credit: true, scenario: { ...scenario, events: [] }, agents: 20, rounds: 5 };
    expect((await json(target, "/v1/runs", free, user)).status).toBe(500);
    const usage = await env.DB.prepare("SELECT used FROM credit_usage").first<{ used: number }>();
    expect(usage!.used).toBe(0);
  });
});

describe("the daily cap", () => {
  it("refuses a quote whose budget could never start", async () => {
    target = chainEnv({ DAILY_SPEND_CAP_USD: "5" });
    user = await signIn(target, KEYS.user, NOW);
    const big = await json(target, "/v1/quotes", { scenario, agents: 500, rounds: 20 }, user);
    expect(big.status).toBe(400);
    expect(await big.text()).toContain("over_daily_cap");
    expect((await json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10 }, user)).status).toBe(201);
  });
});

describe("a delivered run", () => {
  it("is accepted when it overshot its budget by a call: the money is spent, the payer gets the run", async () => {
    const runId = await paidRun();
    const job = await claim();
    const over = runFor(runId, (run) => {
      run.usage.costUsd = 0.35;
    });
    expect((await deliver(job, over)).status).toBe(200);
    expect((await status(runId)).job?.status).toBe("complete");
    const spend = await env.DB.prepare("SELECT amount_usd FROM spend WHERE run_id = ?").bind(runId).first();
    expect(spend).toEqual({ amount_usd: 0.35 });
  });

  it.each([
    ["a complete run with fewer rounds", (run: Record<string, any>) => void (run.rounds = run.rounds.slice(0, 9))],
    ["another token", (run: Record<string, any>) => void (run.world.token.symbol = "OTHER")],
    ["other events", (run: Record<string, any>) => void (run.scenario.injectedEvents = [])],
  ])("is refused as %s", async (_name, edit) => {
    const runId = await paidRun();
    const job = await claim();
    const response = await deliver(job, runFor(runId, edit));
    expect(response.status).toBe(422);
    expect((await status(runId)).job?.status).toBe("running");
  });

  it("publishes nothing when the lease is lost at the last moment", async () => {
    const runId = await paidRun();
    const job = await claim();
    flaky.beforeNextBatch(async () => {
      await env.DB.prepare("UPDATE jobs SET lease_id = 'lease_other', status = 'running' WHERE run_id = ?").bind(runId).run();
    });
    const response = await deliver(job);
    expect(response.status).toBe(409);
    expect((await status(runId)).run).toBeNull();
    expect(await count("oracle_commits")).toBe(0);
    const spend = await env.DB.prepare("SELECT final FROM spend WHERE run_id = ?").bind(runId).first();
    expect(spend).toEqual({ final: 0 });
  });
});

describe("oracle commits", () => {
  async function pending(runId: string) {
    await env.DB.prepare(
      `INSERT INTO oracle_commits (run_id, run_id_bytes32, report_hash, scenario_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(runId, runIdToBytes32(runId), `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, NOW, NOW)
      .run();
  }

  it("two processors at once send one transaction", async () => {
    const runId = "run_01M6FTAPSWS9Q5KVY5BT34XMB1";
    await pending(runId);
    const cfg = config(target);
    await Promise.all([processCommits(env.DB, cfg, NOW), processCommits(env.DB, cfg, NOW)]);
    expect(chain.sent).toHaveLength(1);
    const row = await env.DB.prepare("SELECT status, tx_hash FROM oracle_commits").first<{ status: string; tx_hash: string }>();
    expect(row!.status).toBe("sent");
    expect(row!.tx_hash).toMatch(/^0x/);
  });

  it("keeps retrying with growing waits, past any outage", async () => {
    const runId = "run_01M6FTAPSWS9Q5KVY5BT34XMB1";
    await pending(runId);
    chain.failSend = true;
    for (let i = 0; i < 12; i++) {
      await runScheduled(target, clock.now());
      clock.advance(3600);
    }
    const stuck = await env.DB.prepare("SELECT status, attempts, error FROM oracle_commits").first<{ status: string; attempts: number; error: string }>();
    expect(stuck).toMatchObject({ status: "failed", error: "insufficient funds for gas" });
    expect(stuck!.attempts).toBeGreaterThan(5);
    chain.failSend = false;
    await runScheduled(target, clock.now());
    expect(chain.sent).toHaveLength(1);
  });

  it("waits longer after each failure", async () => {
    const runId = "run_01M6FTAPSWS9Q5KVY5BT34XMB1";
    await pending(runId);
    chain.failSend = true;
    await runScheduled(target, clock.now());
    const first = await env.DB.prepare("SELECT next_attempt_at FROM oracle_commits").first<{ next_attempt_at: number }>();
    expect(first!.next_attempt_at).toBe(NOW + 120);
    clock.advance(60);
    await runScheduled(target, clock.now()); // too early: no new attempt
    const same = await env.DB.prepare("SELECT attempts FROM oracle_commits").first<{ attempts: number }>();
    expect(same!.attempts).toBe(1);
  });

  it("publishing sends this run's commit, even with an older one in flight", async () => {
    await pending("run_01M6FTAPSWS9Q5KVY5BT34XMB1");
    await env.DB.prepare("UPDATE oracle_commits SET status = 'sent', tx_hash = ? WHERE run_id = ?")
      .bind(`0x${"ee".repeat(32)}`, "run_01M6FTAPSWS9Q5KVY5BT34XMB1")
      .run();
    const runId = await paidRun();
    expect((await deliver(await claim())).status).toBe(200);
    expect(chain.sent.map((c) => c.runIdBytes32)).toEqual([runIdToBytes32(runId)]);
  });

  it("does not show a reverted transaction as the commit", async () => {
    const runId = "run_01M6FTAPSWS9Q5KVY5BT34XMB1";
    await pending(runId);
    const bad = `0x${"ee".repeat(32)}`;
    await env.DB.prepare("UPDATE oracle_commits SET status = 'sent', tx_hash = ?").bind(bad).run();
    chain.txs.set(bad, { status: "reverted", blockNumber: 5n });
    chain.commits.set(runIdToBytes32(runId), {
      reportHash: `0x${"11".repeat(32)}`,
      scenarioHash: `0x${"22".repeat(32)}`,
      resolvesAt: 0n,
      committedAt: 1n,
      resolvedAt: 0n,
      outcomeHash: `0x${"0".repeat(64)}`,
    });
    await runScheduled(target, clock.now());
    const row = await env.DB.prepare("SELECT status, tx_hash FROM oracle_commits").first();
    expect(row).toEqual({ status: "confirmed", tx_hash: null });
  });

  it("stops for good when the chain holds another hash, and says why in the admin view", async () => {
    const runId = "run_01M6FTAPSWS9Q5KVY5BT34XMB1";
    await pending(runId);
    chain.commits.set(runIdToBytes32(runId), {
      reportHash: `0x${"33".repeat(32)}`,
      scenarioHash: `0x${"22".repeat(32)}`,
      resolvesAt: 0n,
      committedAt: 1n,
      resolvedAt: 0n,
      outcomeHash: `0x${"0".repeat(64)}`,
    });
    await runScheduled(target, clock.now());
    const row = await env.DB.prepare("SELECT status, next_attempt_at FROM oracle_commits").first();
    expect(row).toEqual({ status: "failed", next_attempt_at: null });
    const admin = await signIn(target, KEYS.admin, NOW);
    const overview = AdminOverviewResponse.parse(await (await call(target, "/v1/admin/overview", { headers: admin })).json());
    expect(overview.oracle.failed).toBe(1);
    expect(overview.oracle.lastError).toContain("another hash");
  });
});

describe("the admin view", () => {
  it("gives each refund's token so its amount is read right", async () => {
    const usdgOrder = await order();
    const low = chain.pay(usdgOrder.orderId, payer, ADDRESSES.usdg, 1n);
    const unknownOrder = await order();
    const wrong = chain.pay(unknownOrder.orderId, payer, ADDRESSES.other, 5n * 10n ** 18n);
    chain.mine(2);
    await payment(usdgOrder, low);
    await payment(unknownOrder, wrong);
    const admin = await signIn(target, KEYS.admin, NOW);
    const overview = AdminOverviewResponse.parse(await (await call(target, "/v1/admin/overview", { headers: admin })).json());
    const usdg = overview.refunds.find((r) => r.amount === "1")!;
    expect(usdg).toMatchObject({ symbol: "USDG", decimals: 6 });
    const other = overview.refunds.find((r) => r.amount === `${5n * 10n ** 18n}`)!;
    expect(other).toMatchObject({ symbol: null, decimals: null });
  });
});

describe("reads that cost an RPC call are limited", () => {
  it("limits /v1/me per wallet", async () => {
    for (let i = 0; i < 30; i++) expect((await call(target, "/v1/me", { headers: user })).status).toBe(200);
    expect((await call(target, "/v1/me", { headers: user })).status).toBe(429);
  });

  it("limits /v1/oracle/:runId per IP", async () => {
    const path = "/v1/oracle/run_01M6FTAPSWS9Q5KVY5BT34XMB1";
    for (let i = 0; i < 60; i++) expect((await call(target, path)).status).toBe(404);
    expect((await call(target, path)).status).toBe(429);
  });
});
