import { CheckError, isAddress } from "@hyvo/check";
import { noExtra, parseArgs, stringOption, type OptionSpec } from "../args.js";
import { hostOf, loadSettings, resolveRpc } from "../config.js";
import type { Context } from "../context.js";
import { checkJson } from "../format/check.js";
import { McpServer, ToolFailure, type ToolDefinition, type ToolHandler } from "../mcp.js";
import { ORACLE } from "../oracle.js";
import { VERSION } from "../version.js";
import { RUN_DISCLAIMER, verifyRun } from "../verify.js";
import { parseEthIn } from "./check.js";
import { CommandError, describeError, EXIT } from "./common.js";
import { verifySettings } from "./verify.js";

export const MCP_HELP = `hyvo mcp: a Model Context Protocol server on stdio, for AI agents

USAGE
  hyvo mcp [--rpc <url>] [--api <url>]

TOOLS
  check_token   Facts about a Robinhood Chain token with their evidence, and an exit simulation
  verify_run    Recompute a published Hyvo run's hash and compare it with its on-chain commit

Register it with an MCP client as a stdio server, for example:
  { "mcpServers": { "hyvo": { "command": "npx", "args": ["-y", "hyvo", "mcp"] } } }

Read-only: no tool signs or sends anything, and hyvo holds no key.
`;

const OPTIONS: OptionSpec = {
  rpc: { type: "string" },
  api: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const INSTRUCTIONS = `Read-only tools for Robinhood Chain (chain 4663). check_token reads a token at one block and returns facts, each with its evidence, and an exit simulation inside one eth_call; it gives no verdict. verify_run proves a published Hyvo run from its run.json and the chain. Present results as facts: never as advice to trade, a rating of a token or a price prediction. Check results: Measured on-chain at block N. Not a trading signal. Run results: ${RUN_DISCLAIMER}`;

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "check_token",
    title: "Check a Robinhood Chain token",
    description:
      "Read a token on Robinhood Chain at one block: verified source, owner, proxy, mint, fee, blocklist and pause functions, where it trades, top holders and deployer, each finding with its evidence and a status of found, not_found or skipped. Then simulate an exit inside one read-only eth_call: buy with made-up ETH, send a tenth to a fresh address, sell the rest, and compare each step with what the venue's own math promised. Facts, not a verdict. The result's disclaimer reads: Measured on-chain at block N. Not a trading signal.",
    // `address`, as in check_token of Hyvo's remote MCP server (apps/api), so one call fits both.
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "string", description: "The token's contract address on Robinhood Chain (chain 4663): 0x and 40 hex characters." },
        ethIn: { type: "string", description: "ETH the simulated buy spends, such as 0.001 (the default); at most 1000." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "verify_run",
    title: "Verify a Hyvo run against the chain",
    description: `Download a published Hyvo run's exact run.json from the Hyvo API, recompute its hash here (RFC 8785 and keccak-256), and read its commit in HyvoOracle ${ORACLE.address} on Robinhood Chain through an RPC. verified is true only when the file hashes to its own hash and the chain holds that hash and the scenario's hash. ${RUN_DISCLAIMER}`,
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: { runId: { type: "string", description: "A run id, such as run_01M6QD9NRSBS9QDX37M1NJAEDJ." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

export function mcpHandlers(ctx: Context, options: Record<string, string | boolean>): Record<string, ToolHandler> {
  const rpc = resolveRpc(stringOption(options.rpc), ctx.env, loadSettings(ctx.configDir));
  return {
    async check_token(args, signal) {
      const token = typeof args.address === "string" ? args.address.trim() : "";
      if (!isAddress(token)) throw new ToolFailure("address must be a token address: 0x and 40 hex characters");
      let ethIn: bigint | undefined;
      if (args.ethIn !== undefined) {
        try {
          ethIn = parseEthIn(String(args.ethIn));
        } catch (error) {
          throw new ToolFailure(error instanceof Error ? error.message.replace("--eth-in", "ethIn") : String(error));
        }
      }
      try {
        const report = await ctx.checkToken(token, {
          rpcUrls: [rpc.url],
          fetch: ctx.fetch,
          signal,
          ...(ethIn === undefined ? {} : { ethIn }),
          ...(ctx.env.HYVO_BLOCKSCOUT_KEY ? { blockscoutKey: ctx.env.HYVO_BLOCKSCOUT_KEY } : {}),
        });
        return checkJson(report);
      } catch (error) {
        if (error instanceof CheckError) throw new ToolFailure(`${error.code}: ${error.message}`);
        throw new ToolFailure(`the check could not finish: ${describeError(error, hostOf(rpc.url))}`);
      }
    },
    async verify_run(args, signal) {
      const runId = typeof args.runId === "string" ? args.runId.trim() : "";
      try {
        return { ...(await verifyRun({ runId }, verifySettings(options, ctx, signal))) };
      } catch (error) {
        if (error instanceof CommandError) throw new ToolFailure(`${error.code}: ${error.message}`);
        throw error;
      }
    },
  };
}

export async function runMcp(argv: readonly string[], ctx: Context): Promise<number> {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(MCP_HELP);
    return EXIT.ok;
  }
  noExtra(positional, 0);
  verifySettings(options, ctx); // checks --rpc and --api now, before a client connects
  const server = new McpServer({
    name: "hyvo",
    title: "Hyvo",
    version: VERSION,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    handlers: mcpHandlers(ctx, options),
    write: (message) => ctx.out(`${JSON.stringify(message)}\n`),
    log: (text) => ctx.err(text),
  });
  const pending = new Set<Promise<void>>();
  for await (const line of ctx.stdinLines()) {
    const task: Promise<void> = server
      .handleLine(line)
      .catch((error: unknown) => ctx.err(`hyvo mcp: ${error instanceof Error ? error.message : String(error)}\n`))
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  // stdin closed: answer what is still running, then stop.
  await Promise.allSettled([...pending]);
  return EXIT.ok;
}

