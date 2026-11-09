// The command table. `main` returns the exit code instead of exiting, so stdout always flushes first and tests
// can run every command in-process.

import { UsageError } from "./args.js";
import { runCheck } from "./commands/check.js";
import { EXIT } from "./commands/common.js";
import { runConfig } from "./commands/config.js";
import { runWatch } from "./commands/watch.js";
import { runWatchlist } from "./commands/watchlist.js";
import type { Context } from "./context.js";
import { VERSION } from "./version.js";

export const HELP = `hyvo: Hyvo in your terminal, for Robinhood Chain

USAGE
  hyvo <command> [options]

COMMANDS
  check <token>       Facts about a token, each with its evidence, and an exit simulation (also: scan)
  launches [<token>]  The newest Pons launches, or one launch: pair asset, phase, creator tax, what its
                      curve holds
  stocks [<ticker>]   Robinhood stock tokens, or one: the factory's record, multiplier, Chainlink price
                      and whether it can move right now
  watch [<token>...]  Re-check tokens on an interval and print what changed
  watchlist           The tokens watch follows, kept in a local file
  runs                Recent published runs of Hyvo's crowd simulation
  verify <runId>      Recompute a run's hash and compare it with its commit on Robinhood Chain
  mcp                 A Model Context Protocol server on stdio: check, launches, stocks and verify as tools
  config              Where hyvo reads from: the RPC and the API

OPTIONS
  -h, --help          Show help; hyvo <command> --help for one command
  -v, --version       Show the version

Read-only: hyvo never asks for a key, never signs and never sends a transaction, and sends no telemetry.
Check, launches and stocks results: measured on-chain at one block, not a trading signal. Runs: synthetic
crowd reactions, not trading signals.
`;

type Command = (argv: readonly string[], ctx: Context) => number | Promise<number>;

// The API commands load the SDK and its schemas only when they run, and launches and stocks load viem only then.
const COMMANDS: Record<string, Command> = {
  check: runCheck,
  scan: runCheck,
  launches: async (argv, ctx) => (await import("./commands/launches.js")).runLaunches(argv, ctx),
  stocks: async (argv, ctx) => (await import("./commands/stocks.js")).runStocks(argv, ctx),
  watch: runWatch,
  watchlist: runWatchlist,
  config: runConfig,
  runs: async (argv, ctx) => (await import("./commands/runs.js")).runRuns(argv, ctx),
  verify: async (argv, ctx) => (await import("./commands/verify.js")).runVerify(argv, ctx),
  mcp: async (argv, ctx) => (await import("./commands/mcp.js")).runMcp(argv, ctx),
};

export async function main(argv: readonly string[], ctx: Context): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    const topic = command === "help" ? rest[0] : undefined;
    if (topic && Object.hasOwn(COMMANDS, topic)) return main([topic, "--help"], ctx);
    ctx.out(HELP);
    return EXIT.ok;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    ctx.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run) {
    ctx.err(`hyvo: unknown command: ${command}\n\n${HELP}`);
    return EXIT.usage;
  }
  try {
    return await run(rest, ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.err(`hyvo ${command}: ${error.message}\nRun hyvo ${command} --help for its options.\n`);
      return EXIT.usage;
    }
    ctx.err(`hyvo ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failed;
  }
}
