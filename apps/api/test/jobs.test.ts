import {
  AdminOverviewResponse,
  CreateRunResponse,
  OracleLedgerResponse,
  OracleRunResponse,
  OrderResponse,
  RunListResponse,
  RunnerJob,
  RunResponse,
  runIdToBytes32,
} from "@hyvo/schema";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import goldenText from "../../../fixtures/golden-run.json?raw";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
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
  metaFor,
  resetDb,
  RUNNER_TOKEN,
  runFor,
  runner,
  scenario,
  signIn,
} from "./helpers";

const NOW = 1_800_000_000;
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let user: Record<string, string>;
const payer = account(KEYS.user).address;

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  target = chainEnv();
  user = await signIn(target, KEYS.user, NOW);
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

/** Quote and pay a 50 x 10 run (the golden run's size); returns its runId. */
async function paidRun(body: Record<string, unknown> = {}): Promise<string> {
  const quoted = await json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10, ...body }, user);
  const { order } = OrderResponse.parse(await quoted.json());
  const tx = chain.pay(order.orderId, payer, ADDRESSES.usdg, BigInt(order.amount));
  chain.mine(2);
  const checked = await json(target, `/v1/orders/${order.orderId}/payment`, { txHash: tx }, user);
  return ((await checked.json()) as { order: { runId: string } }).order.runId;
}

async function claim(): Promise<RunnerJob> {
  const response = await runner(target, "/internal/jobs/next");
  expect(response.status).toBe(200);
  return RunnerJob.parse(((await response.json()) as { job: unknown }).job);
}

async function upload(job: RunnerJob, body: string): Promise<Response> {
  const link = (await (await runner(target, `/internal/jobs/${job.runId}/upload-url`, { leaseId: job.leaseId })).json()) as {
    url: string;
  };
  const url = new URL(link.url);
  return call(target, url.pathname + url.search, { method: "PUT", body, headers: { "Content-Type": "application/json" } });
}

async function complete(job: RunnerJob, body: string): Promise<Response> {
  return runner(target, `/internal/jobs/${job.runId}/complete`, { leaseId: job.leaseId, ...(await metaFor(body)) });
}

async function deliver(job: RunnerJob, body = runFor(job.runId)): Promise<Response> {
  expect((await upload(job, body)).status).toBe(200);
  return complete(job, body);
}

async function status(runId: string) {
  return RunResponse.parse(await (await call(target, `/v1/runs/${runId}`)).json());
}

describe("the runner queue", () => {
  it("needs the runner token", async () => {
    expect((await call(target, "/internal/jobs/next")).status).toBe(401);
  });

  it("answers 204 when there is nothing to do", async () => {
    const response = await runner(target, "/internal/jobs/next");
    expect(response.status).toBe(204);
    expect(response.headers.get("X-Hyvo-Queue")).toBe("empty");
  });

  it("hands out a paid job once, with its spec", async () => {
    const runId = await paidRun();
    const job = await claim();
    expect(job).toMatchObject({ runId, attempt: 1, heartbeatIntervalS: 15, timeoutS: 1800 });
    expect(job.spec).toMatchObject({ version: 1, agents: 50, rounds: 10, maxCostUsd: 0.34, maxLlmCalls: 106 });
    expect(job.spec.scenario.title).toBe(scenario.title);
    expect((await runner(target, "/internal/jobs/next")).status).toBe(204);
    expect((await status(runId)).job).toMatchObject({ status: "running", attempt: 1 });
  });

  it("pauses at the daily spend cap and when the founder pauses it", async () => {
    target = chainEnv({ DAILY_SPEND_CAP_USD: "0.5" });
    user = await signIn(target, KEYS.user, NOW);
    await paidRun();
    await paidRun();
    await claim(); // reserves 0.34
    const capped = await runner(target, "/internal/jobs/next");
    expect(capped.status).toBe(204);
    expect(capped.headers.get("X-Hyvo-Queue")).toBe("spend_cap");
    // A new UTC day starts with a clean slate.
    clock.advance(86_400);
    await runner(target, "/internal/jobs/next"); // sweeps the quiet first job too
    const admin = await signIn(target, KEYS.admin, clock.now());
    expect((await json(target, "/v1/admin/queue", { paused: true }, admin)).status).toBe(200);
    const paused = await runner(target, "/internal/jobs/next");
    expect(paused.headers.get("X-Hyvo-Queue")).toBe("paused");
  });

  it("records heartbeats and progress, and refuses a stale lease", async () => {
    const runId = await paidRun();
    const job = await claim();
    const beat = await runner(target, `/internal/jobs/${runId}/heartbeat`, {
      leaseId: job.leaseId,
      progress: { round: 4, rounds: 10 },
    });
    expect(beat.status).toBe(200);
    expect((await status(runId)).job?.progress).toEqual({ round: 4, rounds: 10 });
    const stale = await runner(target, `/internal/jobs/${runId}/heartbeat`, { leaseId: "lease_wrongwrongwrongwrong" });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("lease_lost");
    expect((await runner(target, "/internal/jobs/run_01M6FTAPSWS9Q5KVY5BT34XMZZ/heartbeat", { leaseId: job.leaseId })).status).toBe(404);
  });

  it("publishes a delivered run and commits it on-chain", async () => {
    const runId = await paidRun({ listed: false });
    const job = await claim();
    const done = await deliver(job);
    expect(done.status).toBe(200);
    const body = (await done.json()) as { runId: string; hash: string };
    expect(body.runId).toBe(runId);

    const published = await status(runId);
    expect(published.run).toMatchObject({ runId, crowdSize: 50, rounds: 10 });
    expect(published.job).toMatchObject({ status: "complete", finishedAt: expect.any(String) });
    // Unlisted: reachable by id, not in the gallery.
    const gallery = RunListResponse.parse(await (await call(target, "/v1/runs")).json());
    expect(gallery.runs).toHaveLength(0);

    // The commit went out right after publishing (attester key, resolvesAt 0).
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ runIdBytes32: runIdToBytes32(runId), reportHash: body.hash });
    expect(published.oracle).toMatchObject({ status: "sent", chainId: 4663 });

    // The cron confirms it; the ledger and the per-run view agree with the chain.
    await runScheduled(target, clock.now());
    const after = await status(runId);
    expect(after.oracle).toMatchObject({ status: "confirmed", blockNumber: expect.any(Number) });
    const verified = OracleRunResponse.parse(await (await call(target, `/v1/oracle/${runId}`)).json());
    expect(verified.matches).toBe(true);
    expect(verified.onChain?.reportHash).toBe(body.hash);
    expect(verified.entry.title).toBeNull(); // unlisted
    const ledger = OracleLedgerResponse.parse(await (await call(target, "/v1/oracle")).json());
    expect(ledger.entries.map((e) => e.runId)).toEqual([runId]);

    // Delivering again with the same lease and hash is answered, not refused.
    const again = await complete(job, runFor(runId));
    expect(again.status).toBe(200);
    expect(chain.sent).toHaveLength(1);
    // The real cost replaced the reservation.
    const spend = await env.DB.prepare("SELECT amount_usd, final FROM spend WHERE run_id = ?").bind(runId).first();
    expect(spend).toEqual({ amount_usd: 0, final: 1 });
  });

  it("refuses an upload with a bad link and a run that is not the job", async () => {
    const runId = await paidRun();
    const job = await claim();
    const link = (await (await runner(target, `/internal/jobs/${runId}/upload-url`, { leaseId: job.leaseId })).json()) as { url: string };
    const url = new URL(link.url);
    url.searchParams.set("sig", "0".repeat(64));
    expect((await call(target, url.pathname + url.search, { method: "PUT", body: "{}" })).status).toBe(403);

    expect((await complete(job, runFor(runId))).status).toBe(422); // nothing uploaded yet
    const other = runFor("run_01M6FTAPSWS9Q5KVY5BT34XMB9");
    const wrongId = await deliver(job, other);
    expect(wrongId.status).toBe(422);
    expect(await wrongId.text()).toContain("run_mismatch");
    expect((await status(runId)).job?.status).toBe("running");
  });

  it("refuses another upload than the one reported", async () => {
    const runId = await paidRun();
    const job = await claim();
    await upload(job, runFor(runId));
    const other = runFor(runId, (run) => {
      run.report.summary = "Something else.";
    });
    const response = await complete(job, other);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("run_mismatch");
  });

  it("forgets an upload when the job goes back to the queue", async () => {
    const runId = await paidRun();
    const first = await claim();
    await upload(first, runFor(runId));
    await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: first.leaseId, reason: "x" });
    const second = await claim();
    expect((await complete(second, runFor(runId))).status).toBe(422);
  });

  it("serves exactly the uploaded bytes", async () => {
    const runId = await paidRun();
    const body = runFor(runId);
    expect((await deliver(await claim(), body)).status).toBe(200);
    const link = (await (await call(target, `/v1/runs/${runId}/artifact`)).json()) as { url: string };
    const url = new URL(link.url);
    expect(await (await call(target, url.pathname + url.search)).text()).toBe(body);
  });

  it("re-checks the upload in the Worker with VERIFY_RUNS_IN_WORKER=1 (Workers Paid)", async () => {
    target = chainEnv({ VERIFY_RUNS_IN_WORKER: "1" });
    user = await signIn(target, KEYS.user, NOW);
    const runId = await paidRun();
    const job = await claim();
    const broken = JSON.stringify({ ...JSON.parse(runFor(runId)), hash: `0x${"0".repeat(64)}` });
    expect((await upload(job, broken)).status).toBe(400);
    expect((await deliver(job)).status).toBe(200);
  });

  it("returns a failed attempt to the queue once, then fails it with a refund due", async () => {
    const runId = await paidRun();
    const first = await claim();
    const retry = await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: first.leaseId, reason: "anvil crashed" });
    expect(await retry.json()).toEqual({ status: "queued" });
    const second = await claim();
    expect(second.attempt).toBe(2);
    expect(second.leaseId).not.toBe(first.leaseId);
    // The first lease is dead.
    expect((await runner(target, `/internal/jobs/${runId}/heartbeat`, { leaseId: first.leaseId })).status).toBe(409);
    const final = await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: second.leaseId, reason: "anvil crashed again" });
    expect(await final.json()).toEqual({ status: "failed" });
    expect((await status(runId)).job).toMatchObject({ status: "failed", refund: "due" });

    const admin = await signIn(target, KEYS.admin, NOW);
    const overview = AdminOverviewResponse.parse(await (await call(target, "/v1/admin/overview", { headers: admin })).json());
    expect(overview.failures[0]).toMatchObject({ runId, reason: "anvil crashed again", refund: "due" });
    const refund = overview.refunds.find((r) => r.runId === runId)!;
    expect(refund).toMatchObject({ reason: "run_failed", address: payer, amount: "1000000", status: "due" });
    // The founder records the refund sent from the treasury.
    const sent = await json(target, `/v1/admin/refunds/${refund.id}`, { txHash: `0x${"ef".repeat(32)}`, note: "sent by hand" }, admin);
    expect(sent.status).toBe(200);
    expect((await status(runId)).job?.refund).toBe("sent");
    expect((await json(target, `/v1/admin/refunds/${refund.id}`, { txHash: `0x${"ef".repeat(32)}` }, admin)).status).toBe(404);
  });

  it("fails a job at once when the runner says retrying cannot help", async () => {
    const runId = await paidRun();
    const job = await claim();
    const answer = await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: job.leaseId, reason: "invalid job", retryable: false });
    expect(await answer.json()).toEqual({ status: "failed" });
  });

  it("takes a job back from a runner that went quiet", async () => {
    const runId = await paidRun();
    const first = await claim();
    clock.advance(91);
    const second = await claim(); // the poll sweeps first
    expect(second).toMatchObject({ runId, attempt: 2 });
    expect((await runner(target, `/internal/jobs/${runId}/heartbeat`, { leaseId: first.leaseId })).status).toBe(409);
    clock.advance(91);
    await runScheduled(target, clock.now());
    expect((await status(runId)).job).toMatchObject({ status: "failed", refund: "due" });
  });

  it("takes a job back after its timeout even with heartbeats", async () => {
    const runId = await paidRun();
    const job = await claim();
    for (let i = 0; i < 141; i++) {
      clock.advance(15);
      await runner(target, `/internal/jobs/${runId}/heartbeat`, { leaseId: job.leaseId });
    }
    await runScheduled(target, clock.now()); // 2,115 s > 1,800 s timeout + 300 s grace
    expect((await status(runId)).job).toMatchObject({ status: "queued", attempt: 1 });
  });
});

describe("oracle commits", () => {
  it("retries a failed send and never sends a commit twice", async () => {
    chain.failSend = true;
    const runId = await paidRun();
    expect((await deliver(await claim())).status).toBe(200);
    expect((await status(runId)).oracle?.status).toBe("failed");
    chain.failSend = false;
    clock.advance(121); // the wait after one failure
    await runScheduled(target, clock.now());
    expect(chain.sent).toHaveLength(1);
    await runScheduled(target, clock.now());
    expect((await status(runId)).oracle?.status).toBe("confirmed");
    expect(chain.sent).toHaveLength(1);
  });

  it("flags a run whose id the chain holds with another hash", async () => {
    const runId = await paidRun();
    chain.commits.set(runIdToBytes32(runId), {
      reportHash: `0x${"11".repeat(32)}`,
      scenarioHash: `0x${"22".repeat(32)}`,
      resolvesAt: 0n,
      committedAt: 1n,
      resolvedAt: 0n,
      outcomeHash: `0x${"0".repeat(64)}`,
    });
    expect((await deliver(await claim())).status).toBe(200);
    expect(chain.sent).toHaveLength(0);
    expect((await status(runId)).oracle?.status).toBe("failed");
    const verified = OracleRunResponse.parse(await (await call(target, `/v1/oracle/${runId}`)).json());
    expect(verified.matches).toBe(false);
  });

  it("commits a run published by hand, also one published before the oracle was on", async () => {
    const meta = await metaFor(goldenText);
    const publish = (env: Env, extra: { scenarioHash?: string } = { scenarioHash: meta.scenarioHash }) =>
      call(env, "/internal/runs/publish", {
        method: "POST",
        headers: { Authorization: `Bearer ${RUNNER_TOKEN}` },
        body: `${JSON.stringify({ hash: meta.hash, sha256: meta.sha256, summary: meta.summary, ...extra })}\n${goldenText}`,
      });
    const expected = { runIdBytes32: runIdToBytes32(meta.summary.runId), reportHash: meta.hash, scenarioHash: meta.scenarioHash };

    expect((await publish(chainEnv({ ATTESTER_PRIVATE_KEY: "" }))).status).toBe(201);
    expect(chain.sent).toHaveLength(0);

    expect((await publish(target, {})).status).toBe(200);
    expect(chain.sent).toHaveLength(0); // an older client sends no scenario hash: published, not committed

    expect((await publish(target)).status).toBe(200);
    expect(chain.sent).toEqual([expect.objectContaining(expected)]);

    expect((await publish(target)).status).toBe(200);
    expect(chain.sent).toHaveLength(1); // written once
  });

  it("does not commit a run that was taken out of the gallery when it is published again", async () => {
    const meta = await metaFor(goldenText);
    const publish = () =>
      call(target, "/internal/runs/publish", {
        method: "POST",
        headers: { Authorization: `Bearer ${RUNNER_TOKEN}` },
        body: `${JSON.stringify({ hash: meta.hash, sha256: meta.sha256, summary: meta.summary, scenarioHash: meta.scenarioHash })}\n${goldenText}`,
      });
    await publish();
    expect(chain.sent).toHaveLength(1); // listed: committed
    await target.DB.prepare("DELETE FROM oracle_commits").run();
    chain.sent.length = 0;
    await target.DB.prepare("UPDATE runs SET listed = 0 WHERE run_id = ?").bind(meta.summary.runId).run();
    expect((await publish()).status).toBe(200);
    expect(chain.sent).toHaveLength(0);
    expect((await call(target, `/v1/oracle/${meta.summary.runId}`)).status).toBe(404);
  });

  it("queues no commit when the oracle is not configured", async () => {
    target = chainEnv({ ATTESTER_PRIVATE_KEY: "" });
    user = await signIn(target, KEYS.user, NOW);
    const runId = await paidRun();
    expect((await deliver(await claim())).status).toBe(200);
    expect((await status(runId)).oracle).toBeNull();
    expect((await call(target, `/v1/oracle/${runId}`)).status).toBe(404);
  });
});

describe("holder free runs", () => {
  const credit = { credit: true, scenario: { ...scenario, events: [] }, agents: 20, rounds: 5 };

  it("runs free for an eligible holder, first in the queue, twice a month", async () => {
    const paidId = await paidRun(); // bought before holding: normal priority
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 10n ** 22n });
    const first = await json(target, "/v1/runs", credit, user);
    expect(first.status).toBe(201);
    const { runId } = CreateRunResponse.parse(await first.json());
    expect((await claim()).runId).toBe(runId); // priority over the older paid job
    expect((await claim()).runId).toBe(paidId);
    expect((await json(target, "/v1/runs", credit, user)).status).toBe(201);
    const third = await json(target, "/v1/runs", credit, user);
    expect(third.status).toBe(403);
    expect(await third.text()).toContain("no_credits");
  });

  it("gives the credit back when the free run fails", async () => {
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 10n ** 22n });
    for (let i = 0; i < 2; i++) {
      const { runId } = CreateRunResponse.parse(await (await json(target, "/v1/runs", credit, user)).json());
      const job = await claim();
      await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: job.leaseId, reason: "x", retryable: false });
    }
    expect((await json(target, "/v1/runs", credit, user)).status).toBe(201);
  });

  it("are closed, and paid runs carry no discount or priority, while the minimum to hold is 0", async () => {
    target = chainEnv({ HOLDER_MIN: "0" });
    user = await signIn(target, KEYS.user, NOW);
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 10n ** 22n });
    const refused = await json(target, "/v1/runs", credit, user);
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain("holder_disabled");
    const quoted = await json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10 }, user);
    expect(OrderResponse.parse(await quoted.json()).order.discountBps).toBe(0);
  });

  it("refuses wallets that were not holders 24 h ago, and runs that are too big", async () => {
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 0n });
    expect((await json(target, "/v1/runs", credit, user)).status).toBe(403);
    chain.balances.set(payer.toLowerCase(), { now: 10n ** 22n, past: 10n ** 22n });
    expect((await json(target, "/v1/runs", { ...credit, agents: 51 }, user)).status).toBe(400);
  });

  it("refuses to start an unpaid order", async () => {
    const quoted = await json(target, "/v1/quotes", { scenario, agents: 50, rounds: 10 }, user);
    const { order } = OrderResponse.parse(await quoted.json());
    const response = await json(target, "/v1/runs", { orderId: order.orderId }, user);
    expect(response.status).toBe(402);
  });
});

describe("admin", () => {
  it("is for founder wallets only", async () => {
    expect((await call(target, "/v1/admin/overview", { headers: user })).status).toBe(403);
    expect((await call(target, "/v1/admin/overview")).status).toBe(401);
  });
});
