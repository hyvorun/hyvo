// `hyvo mcp`: a Model Context Protocol server on stdio, so an AI agent can check a token or verify a run without
// leaving its own workflow. Newline-delimited JSON-RPC 2.0 on stdin and stdout, as the stdio transport defines
// it (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Nothing else is ever written to
// stdout. The server only reads: no tool signs, sends or holds anything.

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}

/** A tool's answer as data, or a failure the model can read: `{ error }`. */
export type ToolHandler = (args: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;

export class ToolFailure extends Error {
  override readonly name = "ToolFailure";
}

type Id = string | number;
type Message = Record<string, unknown>;

export interface McpServerOptions {
  name: string;
  title: string;
  version: string;
  instructions: string;
  tools: readonly ToolDefinition[];
  handlers: Readonly<Record<string, ToolHandler>>;
  write(message: unknown): void;
  /** For what is not the client's business: stderr. */
  log(text: string): void;
}

const rpcError = (id: Id | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });

export class McpServer {
  private readonly inflight = new Map<Id, AbortController>();

  constructor(private readonly o: McpServerOptions) {}

  /** Handles one line from stdin and writes its answer, if it has one. */
  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.o.write(rpcError(null, -32700, "the line is not JSON"));
      return;
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return this.o.write(rpcError(null, -32600, "an empty batch"));
      const answers = (await Promise.all(parsed.map((m) => this.handle(m)))).filter((a) => a !== null);
      if (answers.length > 0) this.o.write(answers);
      return;
    }
    const answer = await this.handle(parsed);
    if (answer !== null) this.o.write(answer);
  }

  /** Stops every tool call still running (the client went away). */
  abortAll(): void {
    for (const controller of this.inflight.values()) controller.abort();
  }

  private async handle(raw: unknown): Promise<unknown> {
    if (typeof raw !== "object" || raw === null) return rpcError(null, -32600, "a message must be a JSON object");
    const { jsonrpc, id, method, params } = raw as Message;
    const hasId = typeof id === "string" || typeof id === "number";
    if (jsonrpc !== "2.0") return hasId ? rpcError(id as Id, -32600, "this is not JSON-RPC 2.0") : null;
    if (typeof method !== "string") return null; // a response to a request this server never sends
    const args = typeof params === "object" && params !== null ? (params as Message) : {};
    if (id === undefined) {
      if (method === "notifications/cancelled") {
        const target = args.requestId;
        if (typeof target === "string" || typeof target === "number") this.inflight.get(target)?.abort();
      }
      return null;
    }
    if (!hasId) return rpcError(null, -32600, "the id must be a string or a number");
    const reqId = id as Id;

    switch (method) {
      case "initialize": {
        const asked = typeof args.protocolVersion === "string" ? args.protocolVersion : "";
        return rpcResult(reqId, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.o.name, title: this.o.title, version: this.o.version },
          instructions: this.o.instructions,
        });
      }
      case "ping":
        return rpcResult(reqId, {});
      case "tools/list":
        return rpcResult(reqId, { tools: this.o.tools });
      case "tools/call":
        return this.call(reqId, args);
      default:
        return rpcError(reqId, -32601, `this server has no method ${method}`);
    }
  }

  private async call(id: Id, params: Message): Promise<unknown> {
    const name = params.name;
    const handler = typeof name === "string" && Object.hasOwn(this.o.handlers, name) ? this.o.handlers[name] : undefined;
    if (!handler) return rpcError(id, -32602, `unknown tool: ${String(name)}`);
    const args = typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Message) : {};
    const controller = new AbortController();
    this.inflight.set(id, controller);
    try {
      const data = await handler(args, controller.signal);
      if (controller.signal.aborted) return null; // cancelled: no answer, as the protocol asks
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (!(error instanceof ToolFailure)) this.o.log(`hyvo mcp: ${String(name)} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      const message = error instanceof Error ? error.message : String(error);
      return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
    } finally {
      this.inflight.delete(id);
    }
  }
}
