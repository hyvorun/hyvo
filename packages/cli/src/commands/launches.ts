import { isAddress } from "@hyvo/check";
import { intOption, noExtra, parseArgs, stringOption, UsageError, type OptionSpec } from "../args.js";
import { loadSettings, resolveRpc } from "../config.js";
import type { Context } from "../context.js";
import { renderOneLaunch, renderRecentLaunches } from "../format/launches.js";
import {
  DEFAULT_HOURS,
  DEFAULT_LIMIT,
  failureText,
  launchesReader,
  MAX_LIMIT,
  MISTYPED_CHECKSUM,
  oneLaunch,
  oneLaunchJson,
  recentLaunches,
  recentLaunchesJson,
  typedToken,
  WINDOW_HOURS,
} from "../launches.js";
import { countRequests, readLine } from "../requests.js";
import { EXIT, printFailure } from "./common.js";

export const LAUNCHES_HELP = `hyvo launches: Pons launches on Robinhood Chain, with the facts their contracts hold

USAGE
  hyvo launches [options]            The newest launches: pair asset, phase, creator tax, what each curve holds
  hyvo launches <token> [options]    One launch's facts, and the last hour of trades on its curve

OPTIONS
  --hours <h>     The window: 1, 6 or 24 hours (default ${DEFAULT_HOURS})
  --limit <n>     How many of the newest launches to list, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})
  --json          Print the facts as JSON, amounts as decimal strings: in the pair asset's smallest unit
                  for liquidity, graduationThreshold, volume, tax and pairTokenAmount, and in the token's
                  (18 decimals) for supply, reserved, sellable and tokenAmount
  --rpc <url>     A Robinhood Chain JSON-RPC endpoint that answers eth_getLogs (default: the public endpoints
                  robinhood.drpc.org, robinhood.api.pocket.network, rpc.mainnet.chain.robinhood.com and
                  rpc.degenprotocol.io, each asked for what it serves)
  -h, --help      Show this help

WHAT IT READS
  The TokenLaunched and PoolGraduated events of the Pons V2 launch factory over the window, then each listed
  launch's bonding curve, in one call at one block: what it holds of its pair asset, the creator tax set at
  launch, and whether it has graduated. For one token: the factory's record and its curve in full, and the
  curve's CurveBuy and CurveSell events of the last hour. Nothing is signed or sent.

EXIT CODES
  0   the facts were read, whatever they are
  2   the chain could not be read
  64  usage error

Measured on-chain at block N. Not a trading signal.
`;

const OPTIONS: OptionSpec = {
  hours: { type: "string" },
  limit: { type: "string" },
  json: { type: "boolean" },
  rpc: { type: "string" },
  help: { type: "boolean", short: "h" },
};

/** `--hours`: one of the windows the web page offers. */
export function hoursOption(value: string | boolean | undefined, name = "--hours"): number {
  if (value === undefined) return DEFAULT_HOURS;
  const text = String(value);
  const hours = Number(text);
  if (!/^\d+$/.test(text) || !(WINDOW_HOURS as readonly number[]).includes(hours)) throw new UsageError(`${name} must be 1, 6 or 24, not ${text}`);
  return hours;
}

export async function runLaunches(argv: readonly string[], ctx: Context): Promise<number> {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(LAUNCHES_HELP);
    return EXIT.ok;
  }
  noExtra(positional, 1);
  const json = options.json === true;
  const typed = positional[0]?.trim();
  if (typed !== undefined && !isAddress(typed)) throw new UsageError(`not an address: ${typed} (expected 0x and 40 hex characters)`);
  if (typed !== undefined && /^0x0{40}$/i.test(typed)) throw new UsageError("the zero address is not a token");
  // Read in its checksummed form, whatever case it was typed in; mixed case must match its checksum.
  const token = typed === undefined ? undefined : typedToken(typed);
  if (token === null) throw new UsageError(`${typed}: ${MISTYPED_CHECKSUM}`);
  if (token !== undefined && (options.hours !== undefined || options.limit !== undefined)) throw new UsageError("--hours and --limit apply to the list, not to one token");
  const hours = hoursOption(options.hours);
  const limit = intOption(options.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
  const rpc = resolveRpc(stringOption(options.rpc), ctx.env, loadSettings(ctx.configDir));
  const requests = countRequests(ctx.fetch);
  const reader = launchesReader(rpc, requests.fetch);
  const started = ctx.now();
  const render = { palette: ctx.palette, width: ctx.columns };

  try {
    if (token === undefined) {
      const result = await recentLaunches(reader, hours, limit);
      const line = readLine(requests.byHost(), ctx.now() - started);
      ctx.out(json ? `${JSON.stringify(recentLaunchesJson(result), null, 2)}\n` : `${renderRecentLaunches(result, { ...render, readLine: line })}\n`);
    } else {
      const result = await oneLaunch(reader, token);
      const line = readLine(requests.byHost(), ctx.now() - started);
      ctx.out(json ? `${JSON.stringify(oneLaunchJson(result), null, 2)}\n` : `${renderOneLaunch(result, { ...render, readLine: line })}\n`);
    }
    return EXIT.ok;
  } catch (error) {
    printFailure(ctx, json, "chain_unavailable", `Robinhood Chain could not be read: ${failureText(error)}`);
    return EXIT.failed;
  }
}
