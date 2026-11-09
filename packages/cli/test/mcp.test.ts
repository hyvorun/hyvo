import { readFileSync } from "node:fs";
import { CheckError } from "@hyvo/check";
import { DEMO_HEAD, DEMO_LAUNCHES, demoChain } from "@hyvo/launches/testing";
import { FEED_DIRECTORY_URL } from "@hyvo/stocks";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/commands/mcp";
import { McpServer, SUPPORTED_VERSIONS, ToolFailure, type ToolHandler } from "../src/mcp";
import { run, sampleReport, testContext, TOKEN } from "./helpers";

function server(handlers: Record<string, ToolHandler> = {}) {
  const written: unknown[] = [];
  const logged: string[] = [];
  const s = new McpServer({
    name: "hyvo",
    title: "Hyvo",
    version: "0.0.0-test",
    instructions: "test",
    tools: TOOLS,
    handlers,
    write: (m) => written.push(m),
    log: (t) => logged.push(t),
  });
  return { s, written, logged };
}

const line = (message: unknown) => JSON.stringify(message);

describe("the MCP protocol", () => {
  it("answers initialize with its tools capability and the version the client asked for, if it knows it", async () => {
    const { s, written } = server();
    await s.handleLine(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    await s.handleLine(line({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }));
    expect(written[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hyvo", title: "Hyvo", version: "0.0.0-test" },
        instructions: "test",
      },
    });
    expect((written[1] as { result: { protocolVersion: string } }).result.protocolVersion).toBe(SUPPORTED_VERSIONS[0]);
  });

  it("lists its five tools, each read-only with an object input schema", async () => {
    const { s, written } = server();
    await s.handleLine(line({ jsonrpc: "2.0", id: "a", method: "tools/list" }));
    const tools = (written[0] as { result: { tools: typeof TOOLS } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["check_token", "recent_launches", "launch_facts", "stock_token", "verify_run"]);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toContain(tool.name === "verify_run" ? "Synthetic crowd reaction. Not a trading signal." : "Not a trading signal.");
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("recent_launches")!.inputSchema).toMatchObject({ properties: { hours: { type: "integer", enum: [1, 6, 24] }, limit: { minimum: 1, maximum: 100 } } });
    expect(byName.get("launch_facts")!.inputSchema.required).toEqual(["address"]);
    expect(byName.get("stock_token")!.inputSchema.required).toEqual(["query"]);
  });

  it("answers ping, ignores notifications and responses, and refuses what it does not know", async () => {
    const { s, written } = server();
    await s.handleLine(line({ jsonrpc: "2.0", id: 3, method: "ping" }));
    await s.handleLine(line({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await s.handleLine(line({ jsonrpc: "2.0", id: 9, result: {} }));
    await s.handleLine(line({ jsonrpc: "2.0", id: 4, method: "resources/list" }));
    await s.handleLine(line({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "sign_transaction", arguments: {} } }));
    await s.handleLine("{not json");
    await s.handleLine("   ");
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 3, result: {} },
      { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "this server has no method resources/list" } },
      { jsonrpc: "2.0", id: 5, error: { code: -32602, message: "unknown tool: sign_transaction" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "the line is not JSON" } },
    ]);
  });

  it("returns a tool's data as text and as structured content, and a failure as isError", async () => {
    const { s, written } = server({
      ok: async () => ({ a: 1 }),
      bad: async () => {
        throw new ToolFailure("token must be an address");
      },
    });
    await s.handleLine(line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ok", arguments: {} } }));
    await s.handleLine(line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bad" } }));
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } } },
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "token must be an address" }], isError: true } },
    ]);
  });

  it("answers a batch with a batch", async () => {
    const { s, written } = server();
    await s.handleLine(line([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]));
    expect(written).toEqual([[{ jsonrpc: "2.0", id: 1, result: {} }]]);
  });

  it("stops a cancelled call and sends no answer for it", async () => {
    let seen: AbortSignal | null = null;
    const { s, written } = server({
      slow: (_args, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const pending = s.handleLine(line({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow", arguments: {} } }));
    await s.handleLine(line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }));
    await pending;
    expect(seen!.aborted).toBe(true);
    expect(written).toEqual([]);
  });
});

describe("hyvo mcp", () => {
  const init = line({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });

  it("speaks only JSON-RPC on stdout, one message per line", async () => {
    const c = testContext({
      stdin: [init, line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_token", arguments: { address: TOKEN } } })],
      checkToken: async () => sampleReport(),
    });
    expect(await run(["mcp"], c)).toBe(0);
    const messages = c.stdout().trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(messages.map((m) => m.id)).toEqual([0, 1]);
    const result = messages[1].result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.disclaimer).toBe("Measured on-chain at block 107512345. Not a trading signal.");
    expect(result.structuredContent.block).toBe("107512345");
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("check_token passes ethIn and refuses bad input as a tool error", async () => {
    let ethIn: bigint | undefined;
    const c = testContext({
      stdin: [
        line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_token", arguments: { address: TOKEN, ethIn: "0.01" } } }),
        line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_token", arguments: { address: "0x12" } } }),
        line({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_token", arguments: { address: TOKEN, ethIn: "5000" } } }),
      ],
      checkToken: async (_a, options = {}) => {
        ethIn = options.ethIn;
        return sampleReport();
      },
    });
    await run(["mcp"], c);
    const byId = new Map(c.stdout().trimEnd().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m.result]));
    expect(ethIn).toBe(10n ** 16n);
    expect(byId.get(2)).toEqual({ content: [{ type: "text", text: "address must be a token address: 0x and 40 hex characters" }], isError: true });
    expect(byId.get(3)).toEqual({ content: [{ type: "text", text: "ethIn must be more than 0 and at most 1000 ETH" }], isError: true });
  });

  it("check_token reports a check that could not be made as a tool error", async () => {
    const c = testContext({
      stdin: [line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_token", arguments: { address: TOKEN } } })],
      checkToken: async () => {
        throw new CheckError("not_a_contract", "no code: it is not a contract");
      },
    });
    await run(["mcp"], c);
    expect(JSON.parse(c.stdout()).result).toEqual({ content: [{ type: "text", text: "not_a_contract: no code: it is not a contract" }], isError: true });
  });

  it("verify_run refuses a malformed run id as a tool error, before any request", async () => {
    const c = testContext({ stdin: [line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verify_run", arguments: { runId: "run_x" } } })] });
    await run(["mcp"], c);
    expect(JSON.parse(c.stdout()).result).toEqual({ content: [{ type: "text", text: "invalid_run_id: not a run id: run_x" }], isError: true });
    expect(c.requests).toEqual([]);
  });

  it("recent_launches returns the same JSON as hyvo launches --json", async () => {
    const chain = demoChain();
    const c = testContext({
      stdin: [line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recent_launches", arguments: { hours: 1, limit: 2 } } })],
      routes: [(url, body) => (url.origin === "https://rpc.test" && body ? { body: JSON.parse(chain.answerText(url.href, body)) } : undefined)],
    });
    expect(await run(["mcp", "--rpc", "https://rpc.test"], c)).toBe(0);
    const result = JSON.parse(c.stdout()).result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.window).toMatchObject({ hours: 1, launches: 5 });
    expect(result.structuredContent.launches).toHaveLength(2);
    expect(result.structuredContent.launches[0]).toMatchObject({ symbol: "FIZZ", liquidity: "59940000000000000" });
    expect(result.structuredContent.notListed).toBe(3);
    expect(result.structuredContent.disclaimer).toBe(`Measured on-chain at block ${DEMO_HEAD}. Not a trading signal.`);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("launch_facts reads one launch, and both launch tools refuse bad input before any request", async () => {
    const chain = demoChain();
    const call = (id: number, name: string, args: unknown) => line({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const c = testContext({
      stdin: [
        call(1, "launch_facts", { address: DEMO_LAUNCHES[0]!.token }),
        call(2, "launch_facts", { address: "0x12" }),
        call(3, "recent_launches", { hours: 5 }),
        call(4, "recent_launches", { limit: 0 }),
      ],
      routes: [(url, body) => (url.origin === "https://rpc.test" && body ? { body: JSON.parse(chain.answerText(url.href, body)) } : undefined)],
    });
    await run(["mcp", "--rpc", "https://rpc.test"], c);
    const byId = new Map(c.stdout().trimEnd().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m.result]));
    expect(byId.get(1).structuredContent).toMatchObject({ kind: "v2", symbol: "FIZZ", lastHour: { trades: 27 } });
    expect(byId.get(2)).toEqual({ content: [{ type: "text", text: "address must be a token address: 0x and 40 hex characters" }], isError: true });
    expect(byId.get(3)).toEqual({ content: [{ type: "text", text: "hours must be 1, 6 or 24, not 5" }], isError: true });
    expect(byId.get(4)).toEqual({ content: [{ type: "text", text: "limit must be a whole number from 1 to 100" }], isError: true });
  });

  it("stock_token reads a token by ticker, and names what the list holds for an unknown one", async () => {
    const stocksFixtures = new URL("../../stocks/test/fixtures/", import.meta.url);
    const recording = JSON.parse(readFileSync(new URL("rpc-nvda.json", stocksFixtures), "utf8")) as { calls: { method: string; params: unknown; result: unknown }[] };
    const answers = new Map(recording.calls.map((r) => [`${r.method} ${JSON.stringify(r.params)}`, r.result]));
    const directory = JSON.parse(readFileSync(new URL("feed-directory.subset.json", stocksFixtures), "utf8")) as { entries: unknown[] };
    const c = testContext({
      stdin: [
        line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stock_token", arguments: { query: "NVDA" } } }),
        line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stock_token", arguments: { query: "APPLE" } } }),
        line({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stock_token", arguments: {} } }),
      ],
      routes: [
        (url) => (url.href === FEED_DIRECTORY_URL ? { body: directory.entries } : undefined),
        (url, body) => {
          if (url.origin !== "https://rpc.test" || !body) return undefined;
          const request = JSON.parse(body) as { id: number; method: string; params?: unknown };
          return { body: { jsonrpc: "2.0", id: request.id, result: answers.get(`${request.method} ${JSON.stringify(request.params ?? [])}`) } };
        },
      ],
    });
    await run(["mcp", "--rpc", "https://rpc.test"], c);
    const byId = new Map(c.stdout().trimEnd().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m.result]));
    const nvda = byId.get(1).structuredContent;
    expect(nvda).toMatchObject({ ticker: "NVDA", verdict: { kind: "registered" }, multiplier: { raw: "1000775159164630595" }, feed: { kind: "read" } });
    expect(nvda.disclaimer).toBe(`Measured on-chain at block ${nvda.block}. Not a trading signal.`);
    expect(byId.get(2).isError).toBe(true);
    expect(byId.get(2).content[0].text).toMatch(/^unknown_ticker: no stock token in Hyvo's list has the ticker APPLE\..*AAPL \(Apple\)/);
    expect(byId.get(3)).toEqual({ content: [{ type: "text", text: "query: give a ticker, such as NVDA, or a contract address" }], isError: true });
  });

  it("describes every tool without a word Hyvo never uses", async () => {
    const { hasBannedWords } = await import("../../check/src/output/copy");
    for (const tool of TOOLS) expect(hasBannedWords(JSON.stringify(tool)), tool.name).toBe(false);
  });
});
