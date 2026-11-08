/** Scenario questions: the lean is committed before the date, the outcome after it, and misses count like hits. */
import { canonicalJson, CalibrationResponse, CreateRunResponse, keccak256Utf8, RunResponse, runIdToBytes32, TopUpResponse, WebhookEvent } from "@hyvo/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { decideQuestion, findQuestion } from "../src/lib/questions";
import { setWebhookFetch } from "../src/lib/webhooks";
import { runScheduled } from "../src/scheduled";
import { ADDRESSES, account, call, chainEnv, FakeChain, frozenClock, json, KEYS, metaFor, resetDb, runFor, runner, scenario, signIn } from "./helpers";

const NOW = 1_800_000_000;
const WEEK = 7 * 86_400;
const TEXT = "Will the token be above its launch price in a week?";
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let user: Record<string, string>;

function when(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  target = chainEnv({ DAILY_SPEND_CAP_USD: "10", PUBLIC_API_URL: "https://api.test" } as Partial<Env>);
  user = await signIn(target, KEYS.user, NOW);
  await runScheduled(target, NOW);
  const top = TopUpResponse.parse(await (await json(target, "/v1/balance/topups", { amountUsd: 20 }, user)).json()).topUp;
  chain.pay(top.orderId, account(KEYS.user).address, ADDRESSES.usdg, BigInt(top.amount));
  chain.mine(5);
  await runScheduled(target, NOW);
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
  setWebhookFetch(null);
});

/** Sessions last a week, and these tests cross weeks. */
async function session(key: `0x${string}`) {
  return signIn(target, key, clock.now());
}

function ask(body: Record<string, unknown>) {
  return json(target, "/v1/runs", { balance: true, scenario: { ...scenario, events: [] }, agents: 50, rounds: 10, ...body }, user);
}

/** A run with a question, played and delivered with the lean given. Returns its id. */
async function played(answers = { yes: 30, no: 15, unsure: 5 }, listed = true): Promise<string> {
  user = await session(KEYS.user);
  const resolvesAt = when(clock.now() + WEEK);
  const response = await ask({ question: { text: TEXT, resolvesAt }, listed });
  expect(response.status).toBe(201);
  const { runId } = CreateRunResponse.parse(await response.json());
  const job = ((await (await runner(target, "/internal/jobs/next")).json()) as { job: { leaseId: string; spec: { question: unknown; maxLlmCalls: number } } }).job;
  expect(job.spec.question).toEqual({ text: TEXT, resolvesAt });
  const body = runFor(runId, (run) => {
    run.scenario.injectedEvents = [];
    const ids = run.crowd.agents.map((agent: { agentId: string }) => agent.agentId);
    const list = [...Array(answers.yes).fill("yes"), ...Array(answers.no).fill("no"), ...Array(answers.unsure).fill("unsure")];
    run.question = {
      text: TEXT,
      resolvesAt,
      answers,
      byAgent: Object.fromEntries(ids.map((id: string, index: number) => [id, list[index] ?? "unsure"])),
      expectation: answers.yes > answers.no ? "yes" : answers.no > answers.yes ? "no" : "split",
    };
  });
  const upload = (await (await runner(target, `/internal/jobs/${runId}/upload-url`, { leaseId: job.leaseId })).json()) as { url: string };
  await call(target, new URL(upload.url).pathname + new URL(upload.url).search, { method: "PUT", body });
  const meta = await metaFor(body);
  const summary = { ...meta.summary, crowdSize: 50, rounds: 10, status: "complete" as const, stopReason: null, personaMix: { sniper: 10, holder: 15, panic_seller: 10, skeptic: 15 } };
  const done = await runner(target, `/internal/jobs/${runId}/complete`, { leaseId: job.leaseId, ...meta, summary, eventRounds: [] });
  expect(done.status, await done.clone().text()).toBe(200);
  await runScheduled(target, clock.now());
  await runScheduled(target, clock.now());
  return runId;
}

async function resolve(runId: string, outcome: string, as?: Record<string, string>, extra: Record<string, unknown> = {}) {
  return json(target, `/v1/admin/questions/${runId}/resolve`, { outcome, note: "Public pool data at the date.", ...extra }, as ?? (await session(KEYS.admin)));
}

async function calibration() {
  return CalibrationResponse.parse(await (await call(target, "/v1/calibration")).json());
}

describe("asking", () => {
  it("is held to its date range", async () => {
    expect((await ask({ question: { text: TEXT, resolvesAt: when(NOW + 60) } })).status).toBe(400);
    expect((await ask({ question: { text: TEXT, resolvesAt: when(NOW + 400 * 86_400) } })).status).toBe(400);
    expect((await ask({ question: { text: TEXT, resolvesAt: "soon" } })).status).toBe(400);
    expect((await ask({ question: { text: "Short?", resolvesAt: when(NOW + WEEK) } })).status).toBe(400);
  });

  it("cannot be used to say what a question should not", async () => {
    const response = await ask({ question: { text: "Holders should sell before the unlock, right now.", resolvesAt: when(NOW + WEEK) } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("neutral");
  });

  it("works for a quote too, which takes the answers into its call budget", async () => {
    const response = await json(target, "/v1/quotes", { scenario: { ...scenario, events: [] }, agents: 50, rounds: 10, question: { text: TEXT, resolvesAt: when(NOW + WEEK) } }, user);
    expect(response.status).toBe(201);
    const bad = await json(target, "/v1/quotes", { scenario: { ...scenario, events: [] }, agents: 50, rounds: 10, question: { text: TEXT, resolvesAt: when(NOW) } }, user);
    expect(bad.status).toBe(400);
  });

  it("refuses a delivered run that is not the question that was ordered", async () => {
    const response = await ask({ question: { text: TEXT, resolvesAt: when(NOW + WEEK) } });
    const { runId } = CreateRunResponse.parse(await response.json());
    const job = ((await (await runner(target, "/internal/jobs/next")).json()) as { job: { leaseId: string } }).job;
    const body = runFor(runId, (run) => (run.scenario.injectedEvents = []));
    const upload = (await (await runner(target, `/internal/jobs/${runId}/upload-url`, { leaseId: job.leaseId })).json()) as { url: string };
    await call(target, new URL(upload.url).pathname + new URL(upload.url).search, { method: "PUT", body });
    const meta = await metaFor(body);
    const done = await runner(target, `/internal/jobs/${runId}/complete`, { leaseId: job.leaseId, ...meta, summary: { ...meta.summary, crowdSize: 50, rounds: 10, status: "complete", stopReason: null, personaMix: { sniper: 10, holder: 15, panic_seller: 10, skeptic: 15 } }, eventRounds: [] });
    expect(done.status).toBe(422);
    expect(await done.text()).toContain("question");
  });
});

describe("the commit", () => {
  it("carries the date, so the run can be resolved", async () => {
    await played();
    expect(chain.sent.at(-1)!.resolvesAt).toBe(BigInt(NOW + WEEK));
  });

  it("is open on the page with its lean before anything is decided", async () => {
    const runId = await played();
    const page = await calibration();
    expect(page.counts).toEqual({ hits: 0, misses: 0, noLean: 0, void: 0, open: 1 });
    expect(page.hitRate).toBeNull();
    expect(page.open[0]).toMatchObject({ runId, question: TEXT, expectation: "yes", yes: 30, no: 15, unsure: 5, overdue: false });
    expect(page.disclaimer).toBe("Synthetic crowd reaction. Not a trading signal.");
  });
});

describe("resolving", () => {
  it("waits for the date", async () => {
    const runId = await played();
    const early = await resolve(runId, "yes");
    expect(early.status).toBe(409);
    expect(await early.text()).toContain("too_early");
    expect(chain.resolved).toEqual([]);
  });

  it("is for founder wallets only", async () => {
    const runId = await played();
    clock.advance(WEEK);
    expect((await resolve(runId, "yes", await session(KEYS.user))).status).toBe(403);
    expect((await resolve(runId, "yes", {})).status).toBe(401);
  });

  it("puts the outcome on-chain, and anyone can check its hash", async () => {
    const runId = await played();
    clock.advance(WEEK);
    const decided = await resolve(runId, "no", undefined, { evidenceUrl: "https://pools.example/x" });
    expect(decided.status).toBe(200);
    const [sent] = chain.resolved;
    expect(sent!.runIdBytes32).toBe(runIdToBytes32(runId));
    expect(sent!.outcomeUri).toBe(`https://api.test/v1/runs/${runId}/outcome`);
    const served = await call(target, `/v1/runs/${runId}/outcome`);
    const bytes = await served.text();
    expect(keccak256Utf8(bytes)).toBe(sent!.outcomeHash);
    const document = JSON.parse(bytes);
    expect(document).toMatchObject({ runId, question: TEXT, expectation: "yes", outcome: "no", evidenceUrl: "https://pools.example/x" });
    expect(canonicalJson(document)).toBe(bytes);
    await runScheduled(target, clock.now());
    const page = await calibration();
    expect(page.resolved[0]).toMatchObject({ runId, outcome: "no", result: "miss", onChain: true, evidenceUrl: "https://pools.example/x" });
    expect(page.resolved[0]!.txHash).toMatch(/^0x/);
    const status = RunResponse.parse(await (await call(target, `/v1/runs/${runId}`)).json());
    expect(status.outcome).toMatchObject({ outcome: "no", status: "confirmed" });
  });

  it("never puts a relative link on-chain: without the API's address it waits, and says why", async () => {
    const runId = await played();
    clock.advance(WEEK);
    await decideQuestion(target.DB, runId, { outcome: "yes", note: "Public pool data at the date." }, clock.now());
    await runScheduled({ ...target, PUBLIC_API_URL: "" }, clock.now());
    expect(chain.resolved).toEqual([]);
    const waiting = await findQuestion(target.DB, runId);
    expect(waiting).toMatchObject({ status: "failed" });
    expect(waiting!.error).toContain("PUBLIC_API_URL");

    clock.advance(86_400);
    await runScheduled(target, clock.now());
    expect(chain.resolved[0]!.outcomeUri).toBe(`https://api.test/v1/runs/${runId}/outcome`);
  });

  it("happens once, whatever is sent later", async () => {
    const runId = await played();
    clock.advance(WEEK);
    expect((await resolve(runId, "yes")).status).toBe(200);
    const again = await resolve(runId, "no");
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("already_resolved");
    await runScheduled(target, clock.now());
    await runScheduled(target, clock.now());
    expect(chain.resolved).toHaveLength(1);
  });

  it("is retried after a failed send, and never sent twice", async () => {
    const runId = await played();
    clock.advance(WEEK);
    chain.failSend = true;
    await resolve(runId, "yes");
    expect(chain.resolved).toHaveLength(0);
    let page = await calibration();
    expect(page.resolved[0]).toMatchObject({ onChain: false, result: "hit" });
    chain.failSend = false;
    await runScheduled(target, clock.now()); // too soon: it waits
    expect(chain.resolved).toHaveLength(0);
    clock.advance(3600);
    await runScheduled(target, clock.now());
    await runScheduled(target, clock.now());
    expect(chain.resolved).toHaveLength(1);
    page = await calibration();
    expect(page.resolved[0]!.onChain).toBe(true);
  });

  it("stops when the chain holds another outcome, and says so", async () => {
    const runId = await played();
    clock.advance(WEEK);
    const bytes32 = runIdToBytes32(runId);
    const commit = chain.commits.get(bytes32)!;
    chain.commits.set(bytes32, { ...commit, resolvedAt: BigInt(NOW), outcomeHash: `0x${"11".repeat(32)}` });
    await resolve(runId, "yes");
    await runScheduled(target, clock.now());
    expect(chain.resolved).toEqual([]);
    expect((await calibration()).resolved[0]!.onChain).toBe(false);
  });

  it("knows a run with no question, and a run with no outcome", async () => {
    expect((await resolve("run_01M6MEGJ413H22963NTZAH32A3", "yes")).status).toBe(404);
    const runId = await played();
    expect((await call(target, `/v1/runs/${runId}/outcome`)).status).toBe(404);
  });

  it("shows up on the founder's list when it is due", async () => {
    const runId = await played();
    const overview = async () => (await (await call(target, "/v1/admin/overview", { headers: await session(KEYS.admin) })).json()) as { questionsDue: { runId: string; overdue: boolean }[] };
    expect((await overview()).questionsDue).toEqual([]);
    clock.advance(WEEK);
    expect((await overview()).questionsDue[0]).toMatchObject({ runId, overdue: true });
    await resolve(runId, "void");
    expect((await overview()).questionsDue).toEqual([]);
  });

  it("tells webhooks once it is on-chain", async () => {
    const received: string[] = [];
    setWebhookFetch(async (_url, init) => {
      received.push(String(init.body));
      return new Response("ok");
    });
    await json(target, "/v1/webhooks", { url: "https://bot.example/", events: ["question.resolved"] }, user);
    const runId = await played();
    clock.advance(WEEK);
    await resolve(runId, "yes");
    await runScheduled(target, clock.now());
    await runScheduled(target, clock.now());
    const [event] = received.map((body) => WebhookEvent.parse(JSON.parse(body)));
    expect(event!.type).toBe("question.resolved");
    expect(event!.data).toMatchObject({ runId, outcome: "yes", result: "hit" });
  });
});

describe("the record", () => {
  async function decide(answers: { yes: number; no: number; unsure: number }, outcome: string, listed = true) {
    const runId = await played(answers, listed);
    clock.advance(WEEK);
    await resolve(runId, outcome);
    await runScheduled(target, clock.now());
    return runId;
  }

  it("counts misses exactly like hits", async () => {
    await decide({ yes: 30, no: 15, unsure: 5 }, "yes");
    await decide({ yes: 15, no: 30, unsure: 5 }, "yes");
    await decide({ yes: 40, no: 5, unsure: 5 }, "no");
    const page = await calibration();
    expect(page.counts).toMatchObject({ hits: 1, misses: 2 });
    expect(page.hitRate).toBeCloseTo(1 / 3, 6);
    expect(page.resolved.map((entry) => entry.result).sort()).toEqual(["hit", "miss", "miss"]);
  });

  it("leaves a split crowd and a void question out of the rate, and shows them", async () => {
    await decide({ yes: 20, no: 20, unsure: 10 }, "yes");
    await decide({ yes: 30, no: 15, unsure: 5 }, "void");
    const page = await calibration();
    expect(page.counts).toMatchObject({ hits: 0, misses: 0, noLean: 1, void: 1 });
    expect(page.hitRate).toBeNull();
    expect(page.resolved.map((entry) => entry.result).sort()).toEqual(["no_lean", "void"]);
  });

  it("sorts leans by how firm they were", async () => {
    await decide({ yes: 26, no: 24, unsure: 0 }, "yes"); // 52%
    await decide({ yes: 45, no: 5, unsure: 0 }, "no"); // 90%
    const { buckets } = await calibration();
    expect(buckets.find((bucket) => bucket.label === "50-60%")).toMatchObject({ hits: 1, misses: 0 });
    expect(buckets.find((bucket) => bucket.label === "90-100%")).toMatchObject({ hits: 0, misses: 1 });
  });

  it("keeps an unlisted run off the page", async () => {
    await decide({ yes: 30, no: 15, unsure: 5 }, "yes", false);
    const page = await calibration();
    expect(page.counts.hits).toBe(0);
    expect(page.resolved).toEqual([]);
  });
});
