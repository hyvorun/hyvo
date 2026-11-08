/** Webhooks: events reach the right wallets, signed, once they can, and a dead receiver only hurts itself. */
import { CreateRunResponse, CreateWebhookResponse, TopUpResponse, WebhookDeliveryListResponse, WebhookEvent, WebhookListResponse } from "@hyvo/schema";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { DISABLE_AFTER_FAILURES, RETRY_WAITS_S, setWebhookFetch, webhookUrlProblem } from "../src/lib/webhooks";
import { runScheduled } from "../src/scheduled";
import { ADDRESSES, account, call, chainEnv, FakeChain, frozenClock, json, KEYS, metaFor, resetDb, runFor, runner, scenario, signIn } from "./helpers";

const NOW = 1_800_000_000;
const HOOK = "https://bot.example/hook";
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let session: Record<string, string>;
let received: { url: string; headers: Headers; body: string }[];
let answer: () => Response | Promise<Response>;

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  target = chainEnv({ DAILY_SPEND_CAP_USD: "10" } as Partial<Env>);
  session = await signIn(target, KEYS.user, NOW);
  await runScheduled(target, NOW);
  received = [];
  answer = () => new Response("ok");
  setWebhookFetch(async (url, init) => {
    received.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    return answer();
  });
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
  setWebhookFetch(null);
});

async function hook(events: string[], as = session, url = HOOK) {
  const response = await json(target, "/v1/webhooks", { url, events }, as);
  expect(response.status).toBe(201);
  return CreateWebhookResponse.parse(await response.json());
}

/** A prepaid run, delivered by a runner: it publishes, and the oracle commit is queued. */
async function playRun(as = session, listed = true, deliver = true) {
  const top = TopUpResponse.parse(await (await json(target, "/v1/balance/topups", { amountUsd: 2 }, as)).json()).topUp;
  chain.pay(top.orderId, account(KEYS.user).address, ADDRESSES.usdg, BigInt(top.amount));
  chain.mine(5);
  await runScheduled(target, clock.now());
  const { runId } = CreateRunResponse.parse(await (await json(target, "/v1/runs", { balance: true, scenario, agents: 50, rounds: 10, listed }, as)).json());
  const job = ((await (await runner(target, "/internal/jobs/next")).json()) as { job: { leaseId: string } }).job;
  if (!deliver) return { runId, leaseId: job.leaseId };
  const body = runFor(runId);
  const upload = (await (await runner(target, `/internal/jobs/${runId}/upload-url`, { leaseId: job.leaseId })).json()) as { url: string };
  await call(target, new URL(upload.url).pathname + new URL(upload.url).search, { method: "PUT", body });
  const done = await runner(target, `/internal/jobs/${runId}/complete`, { leaseId: job.leaseId, ...(await metaFor(body)) });
  expect(done.status).toBe(200);
  return { runId, leaseId: job.leaseId };
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function types(): string[] {
  return received.map((item) => item.headers.get("X-Hyvo-Event")!).sort();
}

describe("registering", () => {
  it("shows the secret once and lists the rest", async () => {
    const { webhook, secret } = await hook(["run.completed"]);
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const list = WebhookListResponse.parse(await (await call(target, "/v1/webhooks", { headers: session })).json());
    expect(list.webhooks).toEqual([expect.objectContaining({ id: webhook.id, url: HOOK, events: ["run.completed"], disabledAt: null })]);
    expect(JSON.stringify(list)).not.toContain(secret);
  });

  it("works with an API key", async () => {
    const { key } = (await (await json(target, "/v1/keys", {}, session)).json()) as { key: string };
    await hook(["run.failed"], { Authorization: `Bearer ${key}` });
  });

  it("refuses unknown events and bad URLs", async () => {
    expect((await json(target, "/v1/webhooks", { url: HOOK, events: ["run.exploded"] }, session)).status).toBe(400);
    expect((await json(target, "/v1/webhooks", { url: HOOK, events: [] }, session)).status).toBe(400);
    expect((await json(target, "/v1/webhooks", { url: "http://bot.example/", events: ["run.failed"] }, session)).status).toBe(400);
  });

  it("is limited per wallet", async () => {
    for (let i = 0; i < 5; i++) await hook(["run.failed"]);
    const response = await json(target, "/v1/webhooks", { url: HOOK, events: ["run.failed"] }, session);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("too_many_webhooks");
  });

  it("belongs to one wallet", async () => {
    const { webhook } = await hook(["run.failed"]);
    const other = await signIn(target, KEYS.other, NOW);
    expect((await call(target, `/v1/webhooks/${webhook.id}`, { method: "DELETE", headers: other })).status).toBe(404);
    expect((await call(target, `/v1/webhooks/${webhook.id}/deliveries`, { headers: other })).status).toBe(404);
    expect((await call(target, `/v1/webhooks/${webhook.id}`, { method: "DELETE", headers: session })).status).toBe(200);
  });
});

describe("where a URL may point", () => {
  it.each([
    ["https://bot.example/hook", null],
    ["https://bot.example:8443/hook?x=1", null],
    ["http://bot.example/hook", "https"],
    ["https://localhost/hook", "public host"],
    ["https://127.0.0.1/hook", "public host"],
    ["https://169.254.169.254/latest/meta-data", "public host"],
    ["https://[::1]/hook", "public host"],
    ["https://metadata.google.internal/", "public host"],
    ["https://printer.local/", "public host"],
    ["https://0x7f.0.0.1/", "public host"],
    ["https://user:pw@bot.example/", "user or a password"],
    ["not a url", "not valid"],
    ["ftp://bot.example/", "https"],
  ])("%s", (url, problem) => {
    const found = webhookUrlProblem(url, false);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toContain(problem);
  });

  it("allows a local receiver only on a local stack", () => {
    expect(webhookUrlProblem("http://127.0.0.1:9000/hook", true)).toBeNull();
    expect(webhookUrlProblem("http://127.0.0.1:9000/hook", false)).toContain("https");
    expect(webhookUrlProblem("http://bot.example/hook", true)).toContain("https");
  });
});

describe("events", () => {
  it("are signed so the receiver can check them", async () => {
    const { secret } = await hook(["run.completed"]);
    const { runId } = await playRun();
    await runScheduled(target, clock.now());
    const [delivery] = received;
    expect(delivery!.url).toBe(HOOK);
    const event = WebhookEvent.parse(JSON.parse(delivery!.body));
    expect(event.type).toBe("run.completed");
    expect(event.data.runId).toBe(runId);
    expect(event.disclaimer).toBe("Synthetic crowd reaction. Not a trading signal.");
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(delivery!.headers.get("X-Hyvo-Signature")!)!;
    expect(Number(match[1])).toBe(clock.now());
    expect(match[2]).toBe(await hmac(secret, `${match[1]}.${delivery!.body}`));
    expect(delivery!.headers.get("X-Hyvo-Delivery")).toMatch(/^whd_/);
  });

  it("go out once", async () => {
    await hook(["run.completed"]);
    await playRun();
    await runScheduled(target, clock.now());
    await runScheduled(target, clock.now());
    clock.advance(600);
    await runScheduled(target, clock.now());
    expect(received).toHaveLength(1);
  });

  it("of one wallet's run reach only that wallet; what is public reaches everyone who asked", async () => {
    const other = await signIn(target, KEYS.other, NOW);
    await hook(["run.completed", "run.published"], session, "https://mine.example/");
    await hook(["run.completed", "run.published"], other, "https://theirs.example/");
    await playRun();
    await runScheduled(target, clock.now());
    const mine = received.filter((item) => item.url.startsWith("https://mine")).map((item) => item.headers.get("X-Hyvo-Event"));
    const theirs = received.filter((item) => item.url.startsWith("https://theirs")).map((item) => item.headers.get("X-Hyvo-Event"));
    expect(mine.sort()).toEqual(["run.completed", "run.published"]);
    expect(theirs).toEqual(["run.published"]);
  });

  it("of an unlisted run stay with its wallet", async () => {
    const other = await signIn(target, KEYS.other, NOW);
    await hook(["run.published"], session, "https://mine.example/");
    await hook(["run.published"], other, "https://theirs.example/");
    await playRun(session, false);
    await runScheduled(target, clock.now());
    expect(received.map((item) => item.url)).toEqual(["https://mine.example/"]);
  });

  it("say when a run failed for good, not when it goes back to the queue", async () => {
    await hook(["run.failed"]);
    const { runId, leaseId } = await playRun(session, true, false);
    await runner(target, `/internal/jobs/${runId}/fail`, { leaseId, reason: "boom" });
    await runScheduled(target, clock.now());
    expect(received).toEqual([]);
    const job = ((await (await runner(target, "/internal/jobs/next")).json()) as { job: { leaseId: string } }).job;
    await runner(target, `/internal/jobs/${runId}/fail`, { leaseId: job.leaseId, reason: "boom" });
    await runScheduled(target, clock.now());
    expect(types()).toEqual(["run.failed"]);
    expect(WebhookEvent.parse(JSON.parse(received[0]!.body)).data).toMatchObject({ runId, refund: "credited" });
  });

  it("say when the hash is on-chain", async () => {
    await hook(["oracle.committed"]);
    const { runId } = await playRun();
    await runScheduled(target, clock.now());
    await runScheduled(target, clock.now());
    const committed = received.filter((item) => item.headers.get("X-Hyvo-Event") === "oracle.committed");
    expect(committed).toHaveLength(1);
    const data = WebhookEvent.parse(JSON.parse(committed[0]!.body)).data;
    expect(data).toMatchObject({ runId });
    expect(data.txHash).toMatch(/^0x/);
    expect(data.hash).toMatch(/^0x/);
  });
});

describe("a receiver that fails", () => {
  async function failing(type = "run.completed") {
    const { webhook } = await hook([type]);
    answer = () => new Response("nope", { status: 500 });
    await playRun();
    await runScheduled(target, clock.now());
    return webhook.id;
  }

  it("is tried again with growing waits, then given up on", async () => {
    const id = await failing();
    expect(received).toHaveLength(1);
    for (const wait of RETRY_WAITS_S) {
      await runScheduled(target, clock.now());
      expect(received.length).toBeLessThanOrEqual(RETRY_WAITS_S.indexOf(wait) + 1);
      clock.advance(wait);
      await runScheduled(target, clock.now());
    }
    expect(received).toHaveLength(RETRY_WAITS_S.length + 1);
    clock.advance(86_400);
    await runScheduled(target, clock.now());
    expect(received).toHaveLength(RETRY_WAITS_S.length + 1);
    const { deliveries } = WebhookDeliveryListResponse.parse(await (await call(target, `/v1/webhooks/${id}/deliveries`, { headers: session })).json());
    expect(deliveries[0]).toMatchObject({ status: "failed", attempts: RETRY_WAITS_S.length + 1, lastError: "HTTP 500", nextAttemptAt: null });
  });

  it("counts as delivered once it answers", async () => {
    const id = await failing();
    answer = () => new Response("ok");
    clock.advance(RETRY_WAITS_S[0]!);
    await runScheduled(target, clock.now());
    const { deliveries } = WebhookDeliveryListResponse.parse(await (await call(target, `/v1/webhooks/${id}/deliveries`, { headers: session })).json());
    expect(deliveries[0]).toMatchObject({ status: "delivered", attempts: 2, lastError: null });
  });

  it("that hangs or refuses is recorded like any failure", async () => {
    const { webhook } = await hook(["run.completed"]);
    answer = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
    await playRun();
    await runScheduled(target, clock.now());
    const { deliveries } = WebhookDeliveryListResponse.parse(await (await call(target, `/v1/webhooks/${webhook.id}/deliveries`, { headers: session })).json());
    expect(deliveries[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "TimeoutError" });
  });

  it("does not follow a redirect", async () => {
    await hook(["run.completed"]);
    answer = () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } });
    await playRun();
    await runScheduled(target, clock.now());
    expect(received.map((item) => item.url)).toEqual([HOOK]);
  });

  it("is switched off when it has failed too many deliveries in a row", async () => {
    const { webhook } = await hook(["run.completed"]);
    await env.DB.prepare("UPDATE webhooks SET failed_in_a_row = ? WHERE id = ?").bind(DISABLE_AFTER_FAILURES - 1, webhook.id).run();
    answer = () => new Response("nope", { status: 500 });
    await playRun();
    await runScheduled(target, clock.now());
    for (const wait of RETRY_WAITS_S) {
      clock.advance(wait);
      await runScheduled(target, clock.now());
    }
    const list = WebhookListResponse.parse(await (await call(target, "/v1/webhooks", { headers: session })).json());
    expect(list.webhooks[0]!.disabledAt).not.toBeNull();
  });

  it("does not hold up the others", async () => {
    await hook(["run.completed"], session, "https://dead.example/");
    await hook(["run.completed"], session, "https://alive.example/");
    answer = () => new Response("nope", { status: 500 });
    await playRun();
    await runScheduled(target, clock.now());
    expect(received.map((item) => item.url).sort()).toEqual(["https://alive.example/", "https://dead.example/"]);
  });
});
