import { CheckError } from "@hyvo/check";
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

  it("lists exactly check_token and verify_run, read-only", async () => {
    const { s, written } = server();
    await s.handleLine(line({ jsonrpc: "2.0", id: "a", method: "tools/list" }));
    const tools = (written[0] as { result: { tools: typeof TOOLS } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["check_token", "verify_run"]);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.type).toBe("object");
    }
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

  it("describes both tools without a word Hyvo never uses", async () => {
    const { hasBannedWords } = await import("../../check/src/output/copy");
    for (const tool of TOOLS) expect(hasBannedWords(JSON.stringify(tool)), tool.name).toBe(false);
  });
});
