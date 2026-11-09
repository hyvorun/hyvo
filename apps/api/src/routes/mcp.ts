/**
 * The remote MCP endpoint (SPEC 8.5), over Streamable HTTP without sessions: every POST carries one JSON-RPC message and gets
 * one JSON answer. The server sends nothing on its own, so GET answers 405, which the transport allows, and no SDK or Durable
 * Object is needed. That keeps it inside the Workers Free plan's 10 ms of CPU.
 *
 * Reading runs is open. What spends a balance takes an API key: `Authorization: Bearer hyvo_…`.
 * Specification: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */
import { DISCLAIMER, PrepaidRunRequest, RunId } from "@hyvo/schema";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { askRun, REPORT } from "../lib/ask";
import { API_KEY_PREFIX, bearer, keyAccount } from "../lib/auth";
import { startPrepaidRun } from "../lib/balance";
import { iso, nowS } from "../lib/clock";
import { config, webOrigins, type Config } from "../lib/config";
import { searchRuns, toSummary } from "../lib/db";
import { ApiError } from "../lib/errors";
import { jobView, refundState } from "../lib/jobs";
import { clientIp, rateLimit } from "../lib/ratelimit";
import { ARTIFACT_TTL_SECONDS, signArtifact } from "../lib/signing";
import { oracleStatus } from "./oracle";
import { createOrder } from "./orders";
import { runStatus } from "./runs";

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY_CHARS = 100_000;
const CALLS_PER_MINUTE = 120;
const HOW_TO_VERIFY =
  "Download artifact.url, remove the top-level `hash` field, canonicalize the rest with RFC 8785 (JCS) and take its keccak-256. The result must equal `hash`, and `onChain.reportHash` when the commit is on-chain. docs/API.md has test vectors, and the TypeScript SDK does this in verifyRun().";

const INSTRUCTIONS = `Hyvo plays a synthetic crowd of AI trader agents on a private fork of Robinhood Chain. They post on a simulated feed and swap against real AMM math, and each result is hashed and committed on-chain. Results are synthetic crowd reactions: never present one as advice or as a price prediction. ${DISCLAIMER}`;

const ScenarioSchema = {
  type: "object",
  required: ["title", "seedText"],
  properties: {
    title: { type: "string", description: "What the scenario is, up to 200 characters." },
    seedText: { type: "string", description: "What the crowd is told at the start, up to 4,000 characters." },
    events: {
      type: "array",
      description: "Things that happen during the run.",
      items: {
        type: "object",
        required: ["round", "text"],
        properties: { round: { type: "integer", minimum: 1 }, text: { type: "string" } },
      },
    },
    market: {
      type: "object",
      description: "The test market. Everything here is optional.",
      properties: {
        tokenSymbol: { type: "string" },
        tokenName: { type: "string" },
        liquidityEth: { type: "string" },
        liquidityTokens: { type: "string" },
        feeBps: { type: "integer", minimum: 0, maximum: 1000 },
      },
    },
  },
};

const RUN_ID = { type: "string", description: "A run id, such as run_01M6MEGJ413H22963NTZAH32A3." };

export const TOOLS = [
  {
    name: "create_run",
    title: "Start a simulation",
    description:
      "Start a synthetic crowd simulation, paid from the API key's prepaid balance. If the balance is too low and payments are open, it answers with a quote and how to pay it through PaymentRouter. Needs an API key. A run takes minutes: poll get_run.",
    inputSchema: {
      type: "object",
      required: ["scenario", "size", "rounds"],
      properties: {
        scenario: ScenarioSchema,
        size: { type: "integer", description: "How many agents are in the crowd." },
        rounds: { type: "integer", description: "How many rounds to play." },
        listed: { type: "boolean", description: "Show the run in the public gallery (default true)." },
        requestId: { type: "string", description: "Your id for this request: a retry with the same id pays nothing more." },
        question: {
          type: "object",
          description: "What each agent is asked at the end of the run. Its answer goes on-chain with the run, and the outcome after the date.",
          required: ["text", "resolvesAt"],
          properties: {
            text: { type: "string", description: "A neutral yes or no question, 10 to 300 characters." },
            resolvesAt: { type: "string", description: "When the outcome can be recorded: 2026-12-01T00:00:00Z." },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_run",
    title: "Get a run",
    description: "A run's status and summary: the job while it is queued or playing, the published summary after that.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: RUN_ID } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ask_agent",
    title: "Ask an agent of a run",
    description:
      "Ask one agent of a published run why it did what it did, or ask `report` about the run as a whole. Costs a small fee from the prepaid balance, and an answer that breaks the copy rules is withheld and not charged. Needs an API key.",
    inputSchema: {
      type: "object",
      required: ["runId", "agentId", "question"],
      properties: {
        runId: RUN_ID,
        agentId: { type: "string", description: "An agent id from the run, such as a07, or `report`." },
        question: { type: "string", description: "Up to 500 characters." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_recent_runs",
    title: "List recent runs",
    description: "Published runs in the public gallery, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            titleContains: { type: "string" },
            status: { type: "string", enum: ["complete", "partial"] },
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "verify_run",
    title: "Verify a run against the chain",
    description:
      "A run's published hash next to its on-chain commit in HyvoOracle, and a link to its run.json so you can recompute the hash yourself. Do recompute it: this API's word is not the proof, the file and the chain are.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: RUN_ID } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

export const mcp = new Hono<AppEnv>();

const methodNotAllowed = (c: Context<AppEnv>) => c.body(null, 405, { Allow: "POST" });
mcp.get("/", methodNotAllowed);
mcp.delete("/", methodNotAllowed);

mcp.post("/", async (c) => {
  const origin = c.req.header("Origin");
  if (origin && !webOrigins(c.env).includes(origin)) return c.json(rpcError(null, -32000, "this Origin is not allowed"), 403);
  const version = c.req.header("MCP-Protocol-Version");
  if (version && !SUPPORTED_VERSIONS.includes(version)) return c.json(rpcError(null, -32600, `unsupported protocol version ${version}`), 400);

  const text = await c.req.text();
  if (text.length > MAX_BODY_CHARS) return c.json(rpcError(null, -32600, "the request is too large"), 413);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return c.json(rpcError(null, -32700, "the body is not JSON"), 400);
  }
  if (Array.isArray(message) || typeof message !== "object" || message === null) {
    return c.json(rpcError(null, -32600, "send one JSON-RPC message per request"), 400);
  }
  const { jsonrpc, id, method, params } = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (jsonrpc !== "2.0") return c.json(rpcError(null, -32600, "this is not JSON-RPC 2.0"), 400);
  // A notification or a response: the server has nothing to say to either.
  if (typeof method !== "string" || id === undefined) return c.body(null, 202);
  if (typeof id !== "string" && typeof id !== "number") return c.json(rpcError(null, -32600, "the id must be a string or a number"), 400);

  const args = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  switch (method) {
    case "initialize": {
      const asked = typeof args.protocolVersion === "string" ? args.protocolVersion : "";
      return c.json(
        rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "hyvo", title: "Hyvo", version: c.env.API_VERSION },
          instructions: INSTRUCTIONS,
        }),
      );
    }
    case "ping":
      return c.json(rpcResult(id, {}));
    case "tools/list":
      return c.json(rpcResult(id, { tools: TOOLS }));
    case "tools/call": {
      const name = args.name;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return c.json(rpcError(id, -32602, `unknown tool: ${String(name)}`));
      const now = nowS();
      const token = bearer(c.req.header("Authorization"));
      let account: string | null = null;
      if (token) {
        account = token.startsWith(API_KEY_PREFIX) ? await keyAccount(c.env.DB, token, now) : null;
        if (!account) return c.json(rpcError(id, -32001, "this API key is not valid"), 401);
      } else {
        await rateLimit(c.env.DB, "mcp", clientIp(c), CALLS_PER_MINUTE, 60, now);
      }
      return c.json(rpcResult(id, await callTool(tool.name, (args.arguments ?? {}) as Record<string, unknown>, { env: c.env, account, now, base: c.env.PUBLIC_API_URL || new URL(c.req.url).origin })));
    }
    default:
      return c.json(rpcError(id, -32601, `this server has no method ${method}`));
  }
});

function rpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

interface CallContext {
  env: Env;
  account: string | null;
  now: number;
  base: string;
}

/** A tool's failure is an answer the model can read and act on, not a protocol error. */
async function callTool(name: (typeof TOOLS)[number]["name"], args: Record<string, unknown>, ctx: CallContext) {
  const cfg = config(ctx.env);
  try {
    const data = await TOOL_CODE[name](args, ctx, cfg);
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    if (error instanceof ApiError) return toolFailure(error.message);
    if (error instanceof z.ZodError) return toolFailure(error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "));
    throw error;
  }
}

function toolFailure(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function needKey(ctx: CallContext): string {
  if (ctx.account) return ctx.account;
  throw new ApiError(401, "unauthorized", "this tool needs an API key: send Authorization: Bearer hyvo_…. A signed-in wallet makes one at POST /v1/keys.");
}

const RunArg = z.object({ runId: RunId });

const TOOL_CODE: Record<(typeof TOOLS)[number]["name"], (args: Record<string, unknown>, ctx: CallContext, cfg: Config) => Promise<Record<string, unknown>>> = {
  async create_run(args, ctx, cfg) {
    const account = needKey(ctx);
    const db = ctx.env.DB;
    await rateLimit(db, "balance-run", account, 10, 60, ctx.now);
    const { scenario, size, rounds, listed, requestId, question } = args;
    const { balance: _, ...request } = PrepaidRunRequest.parse({
      balance: true,
      scenario,
      agents: size,
      rounds,
      ...(listed === undefined ? {} : { listed }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(question === undefined ? {} : { question }),
    });
    try {
      const run = await startPrepaidRun(db, cfg, account, request, ctx.now);
      return {
        status: "started",
        runId: run.runId,
        job: jobView(run.job, await refundState(db, run.runId)),
        chargedUsd: run.chargedUsd,
        next: "Poll get_run; a run takes minutes. Then verify_run.",
        disclaimer: DISCLAIMER,
      };
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "insufficient_balance" || !cfg.features.payments) throw error;
      const order = await createOrder(db, cfg, account, request, ctx.now);
      return {
        status: "payment_required",
        message: error.message,
        order,
        howToPay: `On chain ${order.chainId}: approve ${order.amount} base units of ${order.token.symbol} (${order.token.address}) to ${order.paymentRouter}, then call pay(orderId, token, amount) on it. The run starts when the payment is seen. Or top up the balance at POST /v1/balance/topups and call create_run again.`,
        disclaimer: DISCLAIMER,
      };
    }
  },

  async get_run(args, ctx, cfg) {
    const { runId } = RunArg.parse(args);
    return { ...(await runStatus(ctx.env.DB, cfg, runId)) };
  },

  async ask_agent(args, ctx, cfg) {
    const account = needKey(ctx);
    await rateLimit(ctx.env.DB, "ask", account, 20, 60, ctx.now);
    const { runId, agentId, question } = z
      .object({ runId: RunId, agentId: z.string().regex(new RegExp(`^(a[0-9]{2,4}|${REPORT})$`)), question: z.string().trim().min(1).max(500) })
      .parse(args);
    return { ...(await askRun(ctx.env, cfg, account, { runId, agentId, question }, ctx.now)) };
  },

  async list_recent_runs(args, ctx) {
    const { filter, limit } = z
      .object({
        filter: z.object({ titleContains: z.string().max(100).optional(), status: z.enum(["complete", "partial"]).optional() }).optional(),
        limit: z.int().min(1).max(20).optional(),
      })
      .parse(args);
    const rows = await searchRuns(ctx.env.DB, { limit: limit ?? 10, ...filter });
    const runs = rows.map(toSummary).map(({ sparkline: _s, personaMix: _p, ...run }) => run);
    return { runs, disclaimer: DISCLAIMER };
  },

  async verify_run(args, ctx, cfg) {
    const { runId } = RunArg.parse(args);
    const db = ctx.env.DB;
    const exp = ctx.now + ARTIFACT_TTL_SECONDS;
    const status = await runStatus(db, cfg, runId);
    if (!status.run) throw new ApiError(404, "not_found", "this run is not published yet");
    const sig = await signArtifact(ctx.env.ARTIFACT_SIGNING_KEY, runId, exp);
    const chain = await oracleStatus(db, cfg, runId).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
    return {
      runId,
      hash: status.run.hash,
      commit: chain?.entry ?? null,
      onChain: chain?.onChain ?? null,
      /** Whether the chain holds this hash, as this API read it. null: no commit, or the chain could not be read. */
      matches: chain?.matches ?? null,
      chainId: cfg.chainId,
      oracleAddress: cfg.oracle,
      artifact: { url: `${ctx.base}/v1/artifacts/${runId}/run.json?exp=${exp}&sig=${sig}`, expiresAt: iso(exp) },
      howToVerify: HOW_TO_VERIFY,
      disclaimer: DISCLAIMER,
    };
  },
};
