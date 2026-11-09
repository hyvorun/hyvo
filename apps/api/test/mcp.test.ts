/** The MCP endpoint at protocol level. scripts/e2e-local.ts drives it with the official client over real HTTP. */
import { CreateKeyResponse, TopUpResponse } from "@hyvo/schema";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { insertRun } from "../src/lib/db";
import { queueCommitStatement } from "../src/lib/oracle";
import { SUPPORTED_VERSIONS, TOOLS } from "../src/routes/mcp";
import { runScheduled } from "../src/scheduled";
import { ADDRESSES, account, call, chainEnv, FakeChain, frozenClock, golden, json, KEYS, metaFor, resetDb, runFor, scenario, signIn } from "./helpers";

const NOW = 1_800_000_000;
const DISCLAIMER = "Synthetic crowd reaction. Not a trading signal.";
let target: Env;
let chain: FakeChain;
let clock: ReturnType<typeof frozenClock>;
let session: Record<string, string>;
let aiAnswer: () => unknown;
let nextId = 0;

beforeEach(async () => {
  await resetDb();
  clock = frozenClock(NOW);
  chain = new FakeChain(() => clock.now()).install();
  aiAnswer = () => ({ response: "I held through round 3." });
  target = chainEnv({ DAILY_SPEND_CAP_USD: "10", AI: { run: async () => aiAnswer() } as unknown as Ai } as Partial<Env>);
  session = await signIn(target, KEYS.user, NOW);
  await runScheduled(target, NOW);
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

function post(message: unknown, headers: Record<string, string> = {}) {
  return call(target, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
}

async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const response = await post({ jsonrpc: "2.0", id: ++nextId, method, ...(params === undefined ? {} : { params }) }, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  return (await response.json()) as { id: number; result?: any; error?: { code: number; message: string } };
}

async function tool(name: string, args: unknown, headers: Record<string, string> = {}) {
  const { result, error } = await rpc("tools/call", { name, arguments: args }, headers);
  expect(error).toBeUndefined();
  return result as { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };
}

async function apiKey(): Promise<Record<string, string>> {
  const { key } = CreateKeyResponse.parse(await (await json(target, "/v1/keys", {}, session)).json());
  return { Authorization: `Bearer ${key}` };
}

async function fund(usd: number) {
  const { topUp } = TopUpResponse.parse(await (await json(target, "/v1/balance/topups", { amountUsd: usd }, session)).json());
  chain.pay(topUp.orderId, account(KEYS.user).address, ADDRESSES.usdg, BigInt(topUp.amount));
  chain.mine(5);
  await runScheduled(target, clock.now());
}

async function publishGolden(listed = true, title = "t") {
  const runId = golden.runId as string;
  const key = `runs/${runId}/run.json`;
  const body = runFor(runId);
  await env.ARTIFACTS.put(key, body);
  const meta = await metaFor(body);
  await insertRun(env.DB, { derived: { ...meta.summary, title }, publishedAt: "2026-11-05T00:00:00Z", featured: false, listed, artifactKey: key, sizeBytes: body.length });
  return { runId, hash: meta.hash, scenarioHash: meta.scenarioHash };
}

const runArgs = { scenario: { ...scenario, events: [] }, size: 50, rounds: 10 };

describe("the protocol", () => {
  it("initializes with the version the client asked for, when it knows it", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo.name).toBe("hyvo");
    expect(result.instructions).toContain(DISCLAIMER);
  });

  it("offers its own latest version for one it does not know", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(result.protocolVersion).toBe(SUPPORTED_VERSIONS[0]);
  });

  it("refuses a version header it does not support, and takes one it does", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "1999-01-01" })).status).toBe(400);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "2025-11-25" })).status).toBe(200);
  });

  it("answers ping", async () => {
    expect((await rpc("ping")).result).toEqual({});
  });

  it("accepts a notification with 202 and no body", async () => {
    const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("offers no stream: GET and DELETE answer 405", async () => {
    expect((await call(target, "/mcp")).status).toBe(405);
    expect((await call(target, "/mcp", { method: "DELETE" })).status).toBe(405);
  });

  it("refuses a browser page of another origin, and allows its own web app", async () => {
    const hostile = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://evil.example" });
    expect(hostile.status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: target.WEB_ORIGIN })).status).toBe(200);
  });

  it("answers bad input with JSON-RPC errors", async () => {
    expect(((await (await post("not json")).json()) as any).error.code).toBe(-32700);
    expect(((await (await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).json()) as any).error.code).toBe(-32600);
    expect((await post({ id: 1, method: "ping" })).status).toBe(400);
    expect((await rpc("resources/list")).error?.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "no_such_tool", arguments: {} })).error?.code).toBe(-32602);
    expect((await post("x".repeat(100_001))).status).toBe(413);
  });

  it("lists the five tools of SPEC 8.5 and check_token, each with a schema", async () => {
    const { result } = await rpc("tools/list");
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["ask_agent", "check_token", "create_run", "get_run", "list_recent_runs", "verify_run"]);
    for (const listed of result.tools) expect(listed.inputSchema.type).toBe("object");
    expect(TOOLS).toHaveLength(6);
  });
});

describe("what needs a key", () => {
  it("says so in a way the model can act on", async () => {
    for (const [name, args] of [["create_run", runArgs], ["ask_agent", { runId: golden.runId, agentId: "report", question: "?" }]] as const) {
      const result = await tool(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("API key");
    }
  });

  it("refuses a bad key outright", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_run", arguments: { runId: golden.runId } } }, { Authorization: "Bearer hyvo_nope" });
    expect(response.status).toBe(401);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_run", arguments: { runId: golden.runId } } }, { Authorization: "Bearer a-session-token" })).status).toBe(401);
  });

  it("does not need one to read", async () => {
    await publishGolden();
    expect((await tool("get_run", { runId: golden.runId })).isError).toBeUndefined();
    expect((await tool("list_recent_runs", {})).isError).toBeUndefined();
    expect((await tool("verify_run", { runId: golden.runId })).isError).toBeUndefined();
  });
});

describe("create_run", () => {
  it("starts a run from the balance", async () => {
    const key = await apiKey();
    await fund(5);
    const { structuredContent: data, content } = await tool("create_run", runArgs, key);
    expect(data).toMatchObject({ status: "started", chargedUsd: 1, disclaimer: DISCLAIMER });
    expect(data.runId).toMatch(/^run_/);
    expect(JSON.parse(content[0]!.text)).toEqual(data);
    const left = await env.DB.prepare("SELECT amount_micros FROM balances").first<{ amount_micros: number }>();
    expect(left?.amount_micros).toBe(4_000_000);
    const status = await tool("get_run", { runId: data.runId });
    expect(status.structuredContent.job.status).toBe("queued");
    expect(status.structuredContent.disclaimer).toBe(DISCLAIMER);
  });

  it("pays once when retried with its request id", async () => {
    const key = await apiKey();
    await fund(5);
    const first = await tool("create_run", { ...runArgs, requestId: "mcp-attempt-1" }, key);
    const second = await tool("create_run", { ...runArgs, requestId: "mcp-attempt-1" }, key);
    expect(second.structuredContent.runId).toBe(first.structuredContent.runId);
    const left = await env.DB.prepare("SELECT amount_micros FROM balances").first<{ amount_micros: number }>();
    expect(left?.amount_micros).toBe(4_000_000);
  });

  it("answers with a quote and how to pay when the balance is short", async () => {
    const key = await apiKey();
    const { structuredContent: data, isError } = await tool("create_run", runArgs, key);
    expect(isError).toBeUndefined();
    expect(data.status).toBe("payment_required");
    expect(data.order).toMatchObject({ status: "quoted", amount: "1000000", priceUsd: 1, paymentRouter: "0x00000000000000000000000000000000000000A1" });
    expect(data.howToPay).toContain("pay(orderId, token, amount)");
    // The quote is a real order: paying it starts the run.
    chain.pay(data.order.orderId, account(KEYS.user).address, ADDRESSES.usdg, 1_000_000n);
    chain.mine(5);
    await runScheduled(target, clock.now());
    const jobs = await env.DB.prepare("SELECT source FROM jobs").all<{ source: string }>();
    expect(jobs.results).toEqual([{ source: "paid" }]);
  });

  it("says the balance is short when payments are closed", async () => {
    const off = chainEnv({ PAYMENT_ROUTER_ADDRESS: "" } as Partial<Env>);
    const signed = await signIn(off, KEYS.other, NOW);
    const { key } = CreateKeyResponse.parse(await (await json(off, "/v1/keys", {}, signed)).json());
    const answer = await call(off, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_run", arguments: runArgs } }),
    });
    const { result } = (await answer.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("top up");
  });

  it("names what is wrong with its arguments", async () => {
    const key = await apiKey();
    const missing = await tool("create_run", { size: 50, rounds: 10 }, key);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("scenario");
    const small = await tool("create_run", { ...runArgs, size: 2 }, key);
    expect(small.isError).toBe(true);
    expect(small.content[0]!.text).toContain("agents must be");
  });
});

describe("get_run, list_recent_runs", () => {
  it("know what does not exist", async () => {
    const unknown = await tool("get_run", { runId: "run_01M6MEGJ413H22963NTZAH32A3" });
    expect(unknown.isError).toBe(true);
    expect((await tool("get_run", { runId: "nope" })).isError).toBe(true);
  });

  it("list published runs, and filter them, without what is not meant for the gallery", async () => {
    await publishGolden(true, "Fictional token GLINT lists");
    const all = await tool("list_recent_runs", {});
    expect(all.structuredContent.runs).toHaveLength(1);
    expect(all.structuredContent.runs[0].sparkline).toBeUndefined();
    expect(all.structuredContent.disclaimer).toBe(DISCLAIMER);
    expect((await tool("list_recent_runs", { filter: { titleContains: "glint" } })).structuredContent.runs).toHaveLength(1);
    expect((await tool("list_recent_runs", { filter: { titleContains: "moss" } })).structuredContent.runs).toHaveLength(0);
    expect((await tool("list_recent_runs", { filter: { status: "partial" } })).structuredContent.runs).toHaveLength(0);
    expect((await tool("list_recent_runs", { limit: 21 })).isError).toBe(true);
    await resetDb();
    await publishGolden(false);
    expect((await tool("list_recent_runs", {})).structuredContent.runs).toHaveLength(0);
  });

  it("treat % and _ in a filter as plain text", async () => {
    await publishGolden(true, "Fictional token GLINT lists");
    expect((await tool("list_recent_runs", { filter: { titleContains: "%" } })).structuredContent.runs).toHaveLength(0);
    expect((await tool("list_recent_runs", { filter: { titleContains: "_" } })).structuredContent.runs).toHaveLength(0);
  });
});

describe("ask_agent", () => {
  it("answers and charges the balance", async () => {
    const { runId } = await publishGolden();
    const key = await apiKey();
    await fund(1);
    const { structuredContent: data } = await tool("ask_agent", { runId, agentId: golden.crowd.agents[0].agentId, question: "Why?" }, key);
    expect(data).toMatchObject({ answer: "I held through round 3.", withheld: false, chargedUsd: 0.01, disclaimer: DISCLAIMER });
  });

  it("refuses what is not an agent or a question", async () => {
    const { runId } = await publishGolden();
    const key = await apiKey();
    expect((await tool("ask_agent", { runId, agentId: "Robert'); DROP", question: "?" }, key)).isError).toBe(true);
    expect((await tool("ask_agent", { runId, agentId: "report", question: "" }, key)).isError).toBe(true);
  });
});

describe("verify_run", () => {
  it("shows the published hash next to the chain's", async () => {
    const { runId, hash, scenarioHash } = await publishGolden();
    await queueCommitStatement(env.DB, { runId, runIdBytes32: "0x" + "ab".repeat(32), reportHash: hash, scenarioHash }, NOW).run();
    await runScheduled(target, clock.now());
    await runScheduled(target, clock.now());
    const { structuredContent: data } = await tool("verify_run", { runId });
    expect(data).toMatchObject({ runId, hash, matches: true, chainId: 4663, disclaimer: DISCLAIMER });
    expect(data.onChain.reportHash).toBe(hash);
    expect(data.commit.status).toBe("confirmed");
    expect(data.howToVerify).toContain("RFC 8785");
    const bytes = await (await call(target, new URL(data.artifact.url).pathname + new URL(data.artifact.url).search)).text();
    expect(JSON.parse(bytes).hash).toBe(hash);
  });

  it("says when the chain holds another hash", async () => {
    const { runId, hash, scenarioHash } = await publishGolden();
    const bytes32 = ("0x" + "ab".repeat(32)) as `0x${string}`;
    await queueCommitStatement(env.DB, { runId, runIdBytes32: bytes32, reportHash: hash, scenarioHash }, NOW).run();
    chain.commits.set(bytes32, {
      reportHash: ("0x" + "11".repeat(32)) as `0x${string}`,
      scenarioHash: scenarioHash as `0x${string}`,
      resolvesAt: 0n,
      committedAt: BigInt(NOW),
      resolvedAt: 0n,
      outcomeHash: ("0x" + "00".repeat(32)) as `0x${string}`,
    });
    const { structuredContent: data } = await tool("verify_run", { runId });
    expect(data.matches).toBe(false);
  });

  it("is plain about a run with no commit, and one not published", async () => {
    const { runId } = await publishGolden();
    const { structuredContent: data } = await tool("verify_run", { runId });
    expect(data).toMatchObject({ matches: null, commit: null, onChain: null });
    expect(data.artifact.url).toContain("/v1/artifacts/");
    const missing = await tool("verify_run", { runId: "run_01M6MEGJ413H22963NTZAH32A3" });
    expect(missing.isError).toBe(true);
  });
});
