import { CheckError, isAddress, parseEth } from "@hyvo/check";
import { parseArgs, stringOption, UsageError, noExtra, type OptionSpec } from "../args.js";
import { hostOf, loadSettings, resolveRpc } from "../config.js";
import type { Context } from "../context.js";
import { checkJson, renderCheck } from "../format/check.js";
import { describeError, EXIT, printFailure } from "./common.js";

export const CHECK_HELP = `hyvo check: facts about a Robinhood Chain token, each with its evidence, and an exit simulation

USAGE
  hyvo check <token> [options]          (also: hyvo scan <token>)

OPTIONS
  --json            Print the report as JSON (amounts as decimal strings)
  --eth-in <eth>    What the exit simulation buys with (default 0.001)
  --block <n>       Read at this block (default: two blocks below the head)
  --rpc <url>       A Robinhood Chain JSON-RPC endpoint (default https://robinhood.drpc.org)
  -h, --help        Show this help

WHAT IT READS
  At one block: verified source, owner, proxy, mint, fee, blocklist and pause functions, where the token
  trades, the top holders (only with HYVO_BLOCKSCOUT_KEY set) and the deployer. Then, inside one read-only
  eth_call, it buys the token with made-up ETH, sends a tenth to a fresh address and sells the rest, and
  compares each step with what the venue's own math promised. Nothing is signed or sent.

EXIT CODES
  0   a report was made, whatever it found
  2   no report could be made (not a contract, not a token, or the RPC did not answer)
  64  usage error

Measured on-chain at one block. Not a trading signal.
`;

export const CHECK_OPTIONS: OptionSpec = {
  json: { type: "boolean" },
  "eth-in": { type: "string" },
  block: { type: "string" },
  rpc: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const MAX_ETH_IN = 10n ** 21n;

/** `--eth-in`: a decimal ETH amount from 1 wei to 1000 ETH, in wei. */
export function parseEthIn(value: string): bigint {
  let wei: bigint;
  try {
    wei = parseEth(value);
  } catch {
    throw new UsageError(`--eth-in must be an ETH amount such as 0.001, not ${value}`);
  }
  if (wei <= 0n || wei > MAX_ETH_IN) throw new UsageError("--eth-in must be more than 0 and at most 1000 ETH");
  return wei;
}

export function parseBlock(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new UsageError(`--block must be a block number, not ${value}`);
  return BigInt(value);
}

/** The token argument, checked: 0x and 40 hex characters. */
export function tokenArgument(positional: readonly string[]): string {
  const token = positional[0];
  if (!token) throw new UsageError("missing <token>: a token address, 0x and 40 hex characters");
  noExtra(positional, 1);
  if (!isAddress(token.trim())) throw new UsageError(`not an address: ${token} (expected 0x and 40 hex characters)`);
  return token.trim();
}

export async function runCheck(argv: readonly string[], ctx: Context): Promise<number> {
  const { positional, options } = parseArgs(argv, CHECK_OPTIONS);
  if (options.help) {
    ctx.out(CHECK_HELP);
    return EXIT.ok;
  }
  const token = tokenArgument(positional);
  const json = options.json === true;
  const ethIn = stringOption(options["eth-in"]);
  const block = stringOption(options.block);
  const checkOptions = {
    ...(ethIn === undefined ? {} : { ethIn: parseEthIn(ethIn) }),
    ...(block === undefined ? {} : { block: parseBlock(block) }),
    ...(ctx.env.HYVO_BLOCKSCOUT_KEY ? { blockscoutKey: ctx.env.HYVO_BLOCKSCOUT_KEY } : {}),
  };
  const rpc = resolveRpc(stringOption(options.rpc), ctx.env, loadSettings(ctx.configDir));

  try {
    const report = await ctx.checkToken(token, { rpcUrls: [rpc.url], fetch: ctx.fetch, ...checkOptions });
    if (json) ctx.out(`${JSON.stringify(checkJson(report), null, 2)}\n`);
    else ctx.out(`${renderCheck(report, { palette: ctx.palette, width: ctx.columns, rpcUrl: rpc.url })}\n`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CheckError) {
      printFailure(ctx, json, error.code, error.message);
      return EXIT.failed;
    }
    printFailure(ctx, json, "failed", `the check could not finish: ${describeError(error, hostOf(rpc.url))}`);
    return EXIT.failed;
  }
}
