import { CheckError, isAddress } from "@hyvo/check";
import { noExtra, parseArgs, stringOption, type OptionSpec } from "../args.js";
import { hostOf, loadSettings, resolveRpc } from "../config.js";
import type { Context } from "../context.js";
import { checkJson } from "../format/check.js";
import { McpServer, ToolFailure, type ToolDefinition, type ToolHandler } from "../mcp.js";
import { cancellable } from "../requests.js";
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
  check_token      Facts about a Robinhood Chain token with their evidence, and an exit simulation
  recent_launches  The newest Pons launches: pair asset, phase, creator tax, what each curve holds
  launch_facts     One Pons launch: the factory's record, its curve and its last hour of trades
  stock_token      A Robinhood stock token by ticker or address: the factory's record, multiplier,
                   Chainlink price and whether it can move right now
  verify_run       Recompute a published Hyvo run's hash and compare it with its on-chain commit

Register it with an MCP client as a stdio server, for example:
  { "mcpServers": { "hyvo": { "command": "npx", "args": ["-y", "@hyvo/cli", "mcp"] } } }

Read-only: no tool signs or sends anything, and hyvo holds no key.
`;

const OPTIONS: OptionSpec = {
  rpc: { type: "string" },
  api: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const INSTRUCTIONS = `Read-only tools for Robinhood Chain (chain 4663). check_token reads a token at one block and returns facts, each with its evidence, and an exit simulation inside one eth_call; it gives no verdict. recent_launches and launch_facts read Pons launches from the launch factory's events and each bonding curve. stock_token reads a Robinhood stock token: whether the StockFactory records it, its multiplier, its Chainlink price and its pause flags. verify_run proves a published Hyvo run from its run.json and the chain. Present results as facts: never as advice to trade, a rating of a token or a price prediction. Check, launch and stock results: Measured on-chain at block N. Not a trading signal. Run results: ${RUN_DISCLAIMER}`;

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
    name: "recent_launches",
    title: "Newest Pons launches on Robinhood Chain",
    description:
      "Read the newest Pons V2 launches on Robinhood Chain from the chain itself: the launch factory's TokenLaunched and PoolGraduated events over the last 1, 6 or 24 hours, then each listed launch's bonding curve at one block: its pair asset, whether it has graduated, its creator tax in basis points, what its curve holds of the pair asset (liquidity) and the threshold it graduates at. Amounts are decimal strings in the pair asset's smallest unit; progress is liquidity over the threshold. Facts, not a verdict. The result's disclaimer reads: Measured on-chain at block N. Not a trading signal.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", enum: [1, 6, 24], description: "The window, in hours: 1, 6 (the default) or 24." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "How many of the newest launches to return with their curves' state (default 20)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "launch_facts",
    title: "Facts about one Pons launch",
    description:
      "Read one token's Pons launch on Robinhood Chain at one block: the Pons V2 factory's record (creator, fee recipient, pair asset, phase, creator tax, buyback, graduation threshold) and its bonding curve (trading fee, liquidity, supply, tokens kept for the pool and left to sell, the launch-second tax), with the last hour of CurveBuy and CurveSell events on the curve. kind is v2, v1 (a Pons V1 token, which has no curve) or none (no Pons record). Amounts are decimal strings in the smallest unit. Facts, not a verdict. The result's disclaimer reads: Measured on-chain at block N. Not a trading signal.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string", description: "The token's contract address on Robinhood Chain (chain 4663): 0x and 40 hex characters." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "stock_token",
    title: "Facts about a Robinhood stock token",
    description:
      "Look up a Robinhood stock token on Robinhood Chain by ticker or contract address and read it at one block: whether the StockFactory records this contract for its uid (verdict.kind registered, recorded-elsewhere, unknown-uid, not-a-stock-token or no-code), its ERC-8056 multiplier and any scheduled change, its Chainlink feed's price per token and that price divided by the multiplier, whether transfers are paused and whether the oracle is paused, the US equity session at the block's time, and its multiplier history from Hyvo's scan. A price is a reading of a feed at one block, not a quote to trade at and not a forecast. The result's disclaimer reads: Measured on-chain at block N. Not a trading signal.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", description: "A ticker, such as NVDA, or a contract address: 0x and 40 hex characters." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    async recent_launches(args, signal) {
      const { hoursOption } = await import("./launches.js");
      const { DEFAULT_LIMIT, MAX_LIMIT, launchesReader, recentLaunches, recentLaunchesJson, failureText } = await import("../launches.js");
      let hours: number;
      try {
        hours = hoursOption(args.hours === undefined ? undefined : String(args.hours), "hours");
      } catch (error) {
        throw new ToolFailure(error instanceof Error ? error.message : String(error));
      }
      const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ToolFailure(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
      const reader = launchesReader(rpc, cancellable(ctx.fetch, signal));
      try {
        return recentLaunchesJson(await recentLaunches(reader, hours, limit));
      } catch (error) {
        throw new ToolFailure(`chain_unavailable: Robinhood Chain could not be read: ${failureText(error)}`);
      }
    },
    async launch_facts(args, signal) {
      const typed = typeof args.address === "string" ? args.address.trim() : "";
      if (!isAddress(typed) || /^0x0{40}$/i.test(typed)) throw new ToolFailure("address must be a token address: 0x and 40 hex characters");
      const { launchesReader, oneLaunch, oneLaunchJson, failureText, typedToken, MISTYPED_CHECKSUM } = await import("../launches.js");
      const token = typedToken(typed);
      if (token === null) throw new ToolFailure(`address: ${MISTYPED_CHECKSUM}`);
      const reader = launchesReader(rpc, cancellable(ctx.fetch, signal));
      try {
        return oneLaunchJson(await oneLaunch(reader, token));
      } catch (error) {
        throw new ToolFailure(`chain_unavailable: Robinhood Chain could not be read: ${failureText(error)}`);
      }
    },
    async stock_token(args, signal) {
      const { stockFacts, stockFactsJson, stocksClient, stockTarget, targetProblem } = await import("../stocks.js");
      const target = stockTarget(typeof args.query === "string" ? args.query : "");
      if (target.kind === "invalid") throw new ToolFailure(`query: ${target.reason}`);
      if (target.kind === "unknown-ticker") throw new ToolFailure(`unknown_ticker: ${targetProblem(target)}`);
      if (target.kind === "several") throw new ToolFailure(`ambiguous_ticker: ${targetProblem(target)}`);
      const fetchFn = cancellable(ctx.fetch, signal);
      try {
        return stockFactsJson(await stockFacts(stocksClient(rpc, fetchFn), target, fetchFn));
      } catch (error) {
        const message = describeError(error, rpc.from === "default" ? "Robinhood Chain's public endpoints" : hostOf(rpc.url));
        throw new ToolFailure(`chain_unavailable: the token could not be read: ${message.split("\n")[0]}`);
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

