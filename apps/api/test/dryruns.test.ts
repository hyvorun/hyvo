/** Submitting a Dry Run: paid from the balance, played by a runner, and the report stays with the wallet that asked. */
import { BalanceResponse, DryRunListResponse, DryRunReport, DryRunResponse, hashRun, TopUpResponse } from "@hyvo/schema";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sampleText from "../../../fixtures/dryrun-sample.json?raw";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { sha256Bytes } from "../src/lib/ids";
import { setWebhookFetch } from "../src/lib/webhooks";
import { runScheduled } from "../src/scheduled";
import { ADDRESSES, account, call, chainEnv, FakeChain, frozenClock, json, KEYS, resetDb, runner, signIn } from "./helpers";

const NOW = 1_800_000_000;
const sample = JSON.parse(sampleText);
const ABI = [{ type: "function", name: "deposit", inputs: [], stateMutability: "payable" }];
const SUBMISSION = { balance: true, description: "A savings vault.\nPeople deposit ETH.", bytecode: "0x6000", abi: ABI, invariants: ["isSolvent"], agents: 12, rounds: 8 };
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let session: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  target = chainEnv({ DAILY_SPEND_CAP_USD: "10" } as Partial<Env>);
  session = await signIn(target, KEYS.user, NOW);
  await runScheduled(target, NOW);
  const { topUp } = TopUpResponse.parse(await (await json(target, "/v1/balance/topups", { amountUsd: 5 }, session)).json());
  chain.pay(topUp.orderId, account(KEYS.user).address, ADDRESSES.usdg, BigInt(topUp.amount));
  chain.mine(5);
  await runScheduled(target, NOW);
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
  setWebhookFetch(null);
});

function submit(body: Record<string, unknown> = {}, as = session) {
  return json(target, "/v1/dryruns", { ...SUBMISSION, ...body }, as);
}

async function balance() {
  return BalanceResponse.parse(await (await call(target, "/v1/balance", { headers: session })).json());
}

type Claimed = { job: { runId: string; leaseId: string; kind?: string; spec: Record<string, any> } };

async function claim(): Promise<Claimed["job"]> {
  return ((await (await runner(target, "/internal/jobs/next")).json()) as Claimed).job;
}

/** A runner delivers the sample report as this job's. */
async function deliver(job: Claimed["job"]): Promise<{ body: string; response: Response; hash: string }> {
  const document = { ...structuredClone(sample), runId: job.runId };
  delete document.hash;
  document.hash = hashRun(document);
  const body = JSON.stringify(document);
  const upload = (await (await runner(target, `/internal/jobs/${job.runId}/upload-url`, { leaseId: job.leaseId })).json()) as { url: string };
  const put = await call(target, new URL(upload.url).pathname + new URL(upload.url).search, { method: "PUT", body });
  expect(put.status).toBe(200);
  const response = await runner(target, `/internal/jobs/${job.runId}/complete`, {
    leaseId: job.leaseId,
    hash: document.hash,
    sha256: await sha256Bytes(new TextEncoder().encode(body)),
    summary: { status: "complete", findings: { high: 7, medium: 0, low: 2, info: 0 }, calls: 96, reverted: 3 },
    usage: { costUsd: 0.001, llmCalls: 16 },
  });
  return { body, response, hash: document.hash };
}

describe("submitting", () => {
  it("takes the price from the balance and queues a Dry Run for a runner", async () => {
    const response = await submit();
    expect(response.status).toBe(201);
    const { dryRun, disclaimer } = DryRunResponse.parse(await response.json());
    expect(dryRun).toMatchObject({ status: "queued", title: "A savings vault.", chargedUsd: 1, summary: null, hash: null });
    expect(disclaimer).toContain("Synthetic crowd reaction. Not a trading signal.");
    expect(disclaimer).toContain("not an audit");
    expect((await balance()).balanceUsd).toBe(4);
    const job = await claim();
    expect(job.runId).toBe(dryRun.runId);
    expect(job.kind).toBe("dryrun");
    expect(job.spec).toMatchObject({ description: SUBMISSION.description, bytecode: "0x6000", invariants: ["isSolvent"], agents: 12, rounds: 8 });
    expect(job.spec.maxLlmCalls).toBeGreaterThan(0);
  });

  it("works with an API key", async () => {
    const { key } = (await (await json(target, "/v1/keys", {}, session)).json()) as { key: string };
    expect((await submit({}, { Authorization: `Bearer ${key}` })).status).toBe(201);
  });

  it("is refused when the balance is short, with nothing taken and nothing queued", async () => {
    const other = await signIn(target, KEYS.other, NOW);
    const response = await submit({}, other);
    expect(response.status).toBe(402);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({ n: 0 });
  });

  it("pays once when retried with its request id", async () => {
    const first = DryRunResponse.parse(await (await submit({ requestId: "dry-attempt-1" })).json());
    const again = await submit({ requestId: "dry-attempt-1" });
    expect(again.status).toBe(200);
    expect(DryRunResponse.parse(await again.json()).dryRun.runId).toBe(first.dryRun.runId);
    expect((await balance()).balanceUsd).toBe(4);
  });

  it.each([
    [{ bytecode: undefined }, "address"],
    [{ address: "0x" + "1".repeat(40) }, "address"],
    [{ abi: undefined }, "ABI"],
    [{ bytecode: "0xabc" }, "bytecode"],
    [{ description: "" }, "description"],
    [{ agents: 3 }, "agents"],
    [{ rounds: 31 }, "rounds"],
    [{ invariants: ["not a name"] }, "invariants"],
    [{ bytecode: undefined, address: "0x" + "1".repeat(40), constructorArgs: [1] }, "constructorArgs"],
  ])("refuses %j", async (change, where) => {
    const response = await submit(change as Record<string, unknown>);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(where);
    expect((await balance()).balanceUsd).toBe(5);
  });

  it("takes a deployed contract without an ABI: the runner asks for it", async () => {
    const response = await submit({ bytecode: undefined, abi: undefined, address: "0x" + "1".repeat(40) });
    expect(response.status).toBe(201);
    expect((await claim()).spec.address).toBe("0x" + "1".repeat(40));
  });
});

describe("a delivered report", () => {
  it("opens for its wallet, and its hash holds", async () => {
    const { dryRun } = DryRunResponse.parse(await (await submit()).json());
    const { body, response, hash } = await deliver(await claim());
    expect(response.status).toBe(200);
    const status = DryRunResponse.parse(await (await call(target, `/v1/dryruns/${dryRun.runId}`, { headers: session })).json());
    expect(status.dryRun).toMatchObject({ status: "complete", hash, summary: { findings: { high: 7 }, calls: 96 } });
    const report = await call(target, `/v1/dryruns/${dryRun.runId}/report`, { headers: session });
    expect(report.status).toBe(200);
    expect(report.headers.get("Cache-Control")).toContain("private");
    const bytes = await report.text();
    expect(bytes).toBe(body);
    const parsed = DryRunReport.parse(JSON.parse(bytes));
    expect(hashRun(JSON.parse(bytes))).toBe(parsed.hash);
  });

  it("stays private: no other wallet, no gallery, nothing on-chain", async () => {
    const { dryRun } = DryRunResponse.parse(await (await submit()).json());
    await deliver(await claim());
    const other = await signIn(target, KEYS.other, NOW);
    expect((await call(target, `/v1/dryruns/${dryRun.runId}`, { headers: other })).status).toBe(404);
    expect((await call(target, `/v1/dryruns/${dryRun.runId}/report`, { headers: other })).status).toBe(404);
    expect((await call(target, `/v1/dryruns/${dryRun.runId}`)).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oracle_commits").first()).toEqual({ n: 0 });
    await runScheduled(target, NOW);
    expect(chain.sent).toEqual([]);
    expect((await call(target, `/v1/runs/${dryRun.runId}`)).status).toBe(404);
  });

  it("has no report before it is done", async () => {
    const { dryRun } = DryRunResponse.parse(await (await submit()).json());
    expect((await call(target, `/v1/dryruns/${dryRun.runId}/report`, { headers: session })).status).toBe(409);
  });

  it("can be delivered twice with the same answer", async () => {
    await submit();
    const job = await claim();
    const first = await deliver(job);
    expect(first.response.status).toBe(200);
    const again = await runner(target, `/internal/jobs/${job.runId}/complete`, {
      leaseId: job.leaseId,
      hash: first.hash,
      sha256: await sha256Bytes(new TextEncoder().encode(first.body)),
      summary: { status: "complete", findings: { high: 7, medium: 0, low: 2, info: 0 }, calls: 96, reverted: 3 },
      usage: { costUsd: 0.001, llmCalls: 16 },
    });
    expect(again.status).toBe(200);
  });

  it("needs its upload first, and the right one", async () => {
    await submit();
    const job = await claim();
    const meta = { leaseId: job.leaseId, hash: `0x${"ab".repeat(32)}`, sha256: "0".repeat(64), summary: { status: "complete", findings: { high: 0, medium: 0, low: 0, info: 0 }, calls: 0, reverted: 0 }, usage: { costUsd: 0, llmCalls: 0 } };
    expect((await runner(target, `/internal/jobs/${job.runId}/complete`, meta)).status).toBe(422);
  });

  it("tells the wallet's webhook", async () => {
    const received: string[] = [];
    setWebhookFetch(async (_url, init) => {
      received.push(String(init.body));
      return new Response("ok");
    });
    await json(target, "/v1/webhooks", { url: "https://bot.example/", events: ["run.completed", "run.published", "oracle.committed"] }, session);
    await submit();
    await deliver(await claim());
    await runScheduled(target, NOW);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!).type).toBe("run.completed");
  });
});

describe("a Dry Run that fails", () => {
  it("goes back to the queue once, then back to the balance", async () => {
    const { dryRun } = DryRunResponse.parse(await (await submit()).json());
    let job = await claim();
    await runner(target, `/internal/jobs/${job.runId}/fail`, { leaseId: job.leaseId, reason: "anvil died" });
    expect((await balance()).balanceUsd).toBe(4);
    job = await claim();
    await runner(target, `/internal/jobs/${job.runId}/fail`, { leaseId: job.leaseId, reason: "anvil died" });
    expect((await balance()).balanceUsd).toBe(5);
    const status = DryRunResponse.parse(await (await call(target, `/v1/dryruns/${dryRun.runId}`, { headers: session })).json());
    expect(status.dryRun).toMatchObject({ status: "failed", failReason: "anvil died", refund: "credited" });
  });

  it("does not retry what cannot work", async () => {
    await submit();
    const job = await claim();
    const answer = await runner(target, `/internal/jobs/${job.runId}/fail`, { leaseId: job.leaseId, reason: "the constructor reverted", retryable: false });
    expect(await answer.json()).toEqual({ status: "failed" });
    expect((await balance()).balanceUsd).toBe(5);
  });
});

describe("the list", () => {
  it("shows a wallet its own, newest first", async () => {
    await submit({ description: "first" });
    clock.advance(10);
    await submit({ description: "second" });
    const { dryRuns } = DryRunListResponse.parse(await (await call(target, "/v1/dryruns", { headers: session })).json());
    expect(dryRuns.map((item) => item.title)).toEqual(["second", "first"]);
    const other = await signIn(target, KEYS.other, NOW);
    expect(DryRunListResponse.parse(await (await call(target, "/v1/dryruns", { headers: other })).json()).dryRuns).toEqual([]);
  });

  it("cuts a long first line for its title", async () => {
    await submit({ description: "x".repeat(300) });
    const { dryRuns } = DryRunListResponse.parse(await (await call(target, "/v1/dryruns", { headers: session })).json());
    expect(dryRuns[0]!.title.length).toBeLessThanOrEqual(100);
  });
});
