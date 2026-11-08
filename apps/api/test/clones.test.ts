/** Wallet Clone: only the wallet that signed in, only with a session, and a delete leaves nothing. */
import { CloneResponse, CreateRunResponse, TopUpResponse, type CloneProfile } from "@hyvo/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { runScheduled } from "../src/scheduled";
import { account, ADDRESSES, call, chainEnv, FakeChain, frozenClock, json, KEYS, metaFor, resetDb, runFor, runner, scenario, signIn } from "./helpers";

const NOW = 1_800_000_000;
const PROFILE: CloneProfile = {
  version: 1,
  trades: 40,
  buys: 25,
  sells: 15,
  tokens: 9,
  typicalBuyEth: 0.12,
  smallBuyEth: 0.05,
  largeBuyEth: 0.3,
  medianHoldHours: 3.5,
  soldWithinHourPct: 40,
  stillHeldPct: 20,
  medianSellPct: 100,
  medianEntryMinutes: 12,
  earlyEntryPct: 70,
};

let target: Env;
let chain: FakeChain;
let user: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  const clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  target = chainEnv({ DAILY_SPEND_CAP_USD: "10", PUBLIC_API_URL: "https://api.test", CLONES_ENABLED: "1" } as Partial<Env>);
  user = await signIn(target, KEYS.user, NOW);
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

async function mine(as = user) {
  return CloneResponse.parse(await (await call(target, "/v1/clones/me", { headers: as })).json());
}

function build(as = user) {
  return call(target, "/v1/clones/me", { method: "POST", headers: as });
}

/** The runner claims the next job and delivers these numbers. */
async function deliver(profile: unknown = PROFILE) {
  const { job } = (await (await runner(target, "/internal/jobs/next")).json()) as { job: { runId: string; leaseId: string; kind?: string; spec: unknown } };
  const done = await runner(target, `/internal/jobs/${job.runId}/complete`, { leaseId: job.leaseId, profile });
  return { job, done };
}

async function allRows(): Promise<string> {
  const db = target.DB;
  const tables = await db.prepare("SELECT * FROM clones").all();
  const jobs = await db.prepare("SELECT run_id, kind, address, spec_json, status FROM jobs").all();
  return JSON.stringify({ tables: tables.results, jobs: jobs.results });
}

describe("building a clone", () => {
  it("starts with nothing, and says when clones are not open", async () => {
    expect(await mine()).toMatchObject({ clone: null, open: true });
    const closed = chainEnv({ CLONES_ENABLED: "0" } as Partial<Env>);
    const session = await signIn(closed, KEYS.user, NOW);
    const refused = await call(closed, "/v1/clones/me", { method: "POST", headers: session });
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain("clones_closed");
  });

  it("needs a signature in this session: not an API key, and nobody at all", async () => {
    const key = (await (await json(target, "/v1/keys", { label: "bot" }, user)).json()) as { key: string };
    const bearer = { Authorization: `Bearer ${key.key}` };
    expect((await build(bearer)).status).toBe(401);
    expect((await call(target, "/v1/clones/me", { headers: bearer })).status).toBe(401);
    expect((await call(target, "/v1/clones/me", { method: "DELETE", headers: bearer })).status).toBe(401);
    expect((await build({})).status).toBe(401);
  });

  it("asks the runner about the wallet that signed in, and no other", async () => {
    const started = await build();
    expect(started.status).toBe(201);
    expect((await started.clone().json()) as CloneResponse).toMatchObject({ clone: { status: "building", profile: null } });
    const { job, done } = await deliver();
    expect(job.kind).toBe("clone");
    expect(job.spec).toEqual({ address: account(KEYS.user).address });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await mine()).toMatchObject({ clone: { status: "ready", profile: PROFILE, failReason: null } });
  });

  it("gives nobody else's clone to anyone", async () => {
    await build();
    await deliver();
    const other = await signIn(target, KEYS.admin, NOW);
    expect(await mine(other)).toMatchObject({ clone: null });
  });

  it("does not start a second build while one is running", async () => {
    await build();
    const again = await build();
    expect(again.status).toBe(200);
    const count = await target.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'clone'").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("refuses numbers with anything else in them", async () => {
    await build();
    const { done } = await deliver({ ...PROFILE, address: account(KEYS.user).address });
    expect(done.status).toBe(400);
    expect(await mine()).toMatchObject({ clone: { status: "building", profile: null } });
  });

  it("says why when it could not be built, and costs nothing", async () => {
    await build();
    const { job } = (await (await runner(target, "/internal/jobs/next")).json()) as { job: { runId: string; leaseId: string } };
    const failed = await runner(target, `/internal/jobs/${job.runId}/fail`, { leaseId: job.leaseId, reason: "this wallet has 2 trades on Robinhood Chain, and a clone needs at least 5", retryable: false });
    expect(await failed.json()).toMatchObject({ status: "failed" });
    expect(await mine()).toMatchObject({ clone: { status: "failed", failReason: expect.stringContaining("needs at least 5") } });
    const refunds = await target.DB.prepare("SELECT COUNT(*) AS n FROM refunds").first<{ n: number }>();
    expect(refunds?.n).toBe(0);
  });

  it("is not a run: it has no public page", async () => {
    await build();
    const { job } = await deliver();
    expect((await call(target, `/v1/runs/${job.runId}`)).status).toBe(404);
  });
});

describe("deleting a clone", () => {
  async function ready() {
    await build();
    await deliver();
  }

  it("leaves nothing of the wallet's numbers or its address in the job that built it", async () => {
    await ready();
    expect(await allRows()).toContain("typicalBuyEth");
    const gone = await call(target, "/v1/clones/me", { method: "DELETE", headers: user });
    expect(gone.status).toBe(204);
    const rows = await allRows();
    expect(rows).not.toContain("typicalBuyEth");
    expect(rows).not.toContain(account(KEYS.user).address);
    expect(rows).not.toContain(account(KEYS.user).address.toLowerCase());
    expect(await mine()).toMatchObject({ clone: null });
  });

  it("takes the numbers out of a run that was ordered with them", async () => {
    await ready();
    await runScheduled(target, NOW);
    const top = TopUpResponse.parse(await (await json(target, "/v1/balance/topups", { amountUsd: 5 }, user)).json()).topUp;
    chain.pay(top.orderId, account(KEYS.user).address, ADDRESSES.usdg, BigInt(top.amount));
    chain.mine(5);
    await runScheduled(target, NOW);
    const run = await json(target, "/v1/runs", { balance: true, clone: true, scenario: { ...scenario, events: [] }, agents: 50, rounds: 10 }, user);
    expect(run.status, await run.clone().text()).toBe(201);
    expect(await allRows()).toContain("typicalBuyEth");
    await call(target, "/v1/clones/me", { method: "DELETE", headers: user });
    expect(await allRows()).not.toContain("typicalBuyEth");
  });

  it("does not bring a clone back when its job finishes afterwards", async () => {
    await build();
    const { job } = (await (await runner(target, "/internal/jobs/next")).json()) as { job: { runId: string; leaseId: string } };
    await call(target, "/v1/clones/me", { method: "DELETE", headers: user });
    const late = await runner(target, `/internal/jobs/${job.runId}/complete`, { leaseId: job.leaseId, profile: PROFILE });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(await allRows()).not.toContain("typicalBuyEth");
    expect(await mine()).toMatchObject({ clone: null });
  });

  it("can be asked twice", async () => {
    expect((await call(target, "/v1/clones/me", { method: "DELETE", headers: user })).status).toBe(204);
  });
});

describe("a run with a clone", () => {
  async function funded() {
    await runScheduled(target, NOW);
    const top = TopUpResponse.parse(await (await json(target, "/v1/balance/topups", { amountUsd: 5 }, user)).json()).topUp;
    chain.pay(top.orderId, account(KEYS.user).address, ADDRESSES.usdg, BigInt(top.amount));
    chain.mine(5);
    await runScheduled(target, NOW);
  }
  const order = (extra: Record<string, unknown> = {}) => json(target, "/v1/runs", { balance: true, clone: true, scenario: { ...scenario, events: [] }, agents: 50, rounds: 10, ...extra }, user);

  it("needs a clone that is ready", async () => {
    await funded();
    const none = await order();
    expect(none.status).toBe(409);
    expect(await none.text()).toContain("no_clone");
    await build();
    expect((await order()).status).toBe(409);
  });

  it("carries the numbers to the runner, and stays out of the gallery", async () => {
    await funded();
    await build();
    await deliver();
    const response = await order();
    expect(response.status, await response.clone().text()).toBe(201);
    const { runId } = CreateRunResponse.parse(await response.json());
    const { job } = (await (await runner(target, "/internal/jobs/next")).json()) as { job: { spec: { clone: unknown } } };
    expect(job.spec.clone).toEqual(PROFILE);
    const row = await target.DB.prepare("SELECT listed FROM jobs WHERE run_id = ?").bind(runId).first<{ listed: number }>();
    expect(row?.listed).toBe(0);
  });

  it("refuses to be listed or to choose its own mix", async () => {
    await funded();
    expect((await order({ listed: true })).status).toBe(400);
    expect((await order({ mix: { sniper: 50 } })).status).toBe(400);
  });

  it("refuses a delivered run without the clone in it", async () => {
    await funded();
    await build();
    await deliver();
    const { runId } = CreateRunResponse.parse(await (await order()).json());
    const { job } = (await (await runner(target, "/internal/jobs/next")).json()) as { job: { leaseId: string } };
    const body = runFor(runId, (run) => (run.scenario.injectedEvents = []));
    const upload = (await (await runner(target, `/internal/jobs/${runId}/upload-url`, { leaseId: job.leaseId })).json()) as { url: string };
    await call(target, new URL(upload.url).pathname + new URL(upload.url).search, { method: "PUT", body });
    const meta = await metaFor(body);
    const done = await runner(target, `/internal/jobs/${runId}/complete`, {
      leaseId: job.leaseId,
      ...meta,
      summary: { ...meta.summary, crowdSize: 50, rounds: 10, status: "complete", stopReason: null },
      eventRounds: [],
    });
    expect(done.status).toBe(422);
    expect(await done.text()).toContain("clone");
  });
});

describe("a rewind", () => {
  const POOL = `0x${"73".repeat(20)}`;
  async function funded() {
    await runScheduled(target, NOW);
    const top = TopUpResponse.parse(await (await json(target, "/v1/balance/topups", { amountUsd: 5 }, user)).json()).topUp;
    chain.pay(top.orderId, account(KEYS.user).address, ADDRESSES.usdg, BigInt(top.amount));
    chain.mine(5);
    await runScheduled(target, NOW);
  }
  const order = (extra: Record<string, unknown> = {}, events: unknown[] = [{ round: 3, text: "The rumor came two hours earlier." }], market?: unknown) =>
    json(target, "/v1/runs", { balance: true, rewind: { pool: POOL, block: 5000, hours: 6 }, scenario: { title: "Rewind of a launch", seedText: "", events, ...(market ? { market } : {}) }, agents: 50, rounds: 10, ...extra }, user);

  it("carries where to go back to, and stays out of the gallery", async () => {
    await funded();
    const response = await order();
    expect(response.status, await response.clone().text()).toBe(201);
    const { runId } = CreateRunResponse.parse(await response.json());
    const { job } = (await (await runner(target, "/internal/jobs/next")).json()) as { job: { spec: { rewind: unknown } } };
    expect(job.spec.rewind).toEqual({ pool: POOL, block: 5000, hours: 6 });
    const row = await target.DB.prepare("SELECT listed FROM jobs WHERE run_id = ?").bind(runId).first<{ listed: number }>();
    expect(row?.listed).toBe(0);
  });

  it.each([
    ["more than one change", {}, [{ round: 2, text: "One." }, { round: 3, text: "Two." }], undefined, "exactly one event"],
    ["no change", {}, [], undefined, "exactly one event"],
    ["a place in the gallery", { listed: true }, undefined, undefined, "out of the gallery"],
    ["its own liquidity", {}, undefined, { liquidityEth: "5" }, "from the chain"],
    ["a window that is too long", { rewind: { pool: POOL, block: 5000, hours: 100 } }, undefined, undefined, "hours"],
    ["a pool that is not an address", { rewind: { pool: "0x1234", block: 5000, hours: 6 } }, undefined, undefined, "pool"],
  ])("refuses %s", async (_name, extra, events, market, message) => {
    await funded();
    const response = await order(extra as Record<string, unknown>, events as unknown[] | undefined, market);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(message);
  });
});

