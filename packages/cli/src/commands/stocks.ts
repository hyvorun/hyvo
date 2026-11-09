import { SNAPSHOT } from "@hyvo/stocks";
import { noExtra, parseArgs, stringOption, UsageError, type OptionSpec } from "../args.js";
import { hostOf, loadSettings, resolveRpc } from "../config.js";
import type { Context } from "../context.js";
import { renderStockFacts, renderStockList } from "../format/stocks.js";
import { countRequests, readLine } from "../requests.js";
import { stockFacts, stockFactsJson, stockList, stockListJson, stocksClient, stockTarget, targetProblem } from "../stocks.js";
import { describeError, EXIT, printFailure } from "./common.js";

export const STOCKS_HELP = `hyvo stocks: Robinhood stock tokens on Robinhood Chain, from the StockFactory and Chainlink

USAGE
  hyvo stocks [options]                    Every stock token the StockFactory deployed, from Hyvo's scan
  hyvo stocks <ticker|address> [options]   One token, read live: whether the factory records this contract
                                           for its ticker, its multiplier, its Chainlink price and what it
                                           means, and whether it can move right now

OPTIONS
  --search <text>  List only the tokens whose ticker or name contains this text
  --json           Print the facts as JSON (amounts as decimal strings)
  --rpc <url>      A Robinhood Chain JSON-RPC endpoint (default: robinhood.drpc.org, then
                   robinhood.api.pocket.network, then rpc.mainnet.chain.robinhood.com)
  -h, --help       Show this help

WHAT IT READS
  The list is Hyvo's scan of the chain up to block ${SNAPSHOT.block}, which ships with this version; the
  factory's nonce is read live to say whether it has deployed more since. One token is read at one block:
  its uid, name, multiplier and pause flags, and the factory's tokenAddress(uid). Its price is the Chainlink
  feed's answer at that block, at the address Chainlink's feed directory lists
  (reference-data-directory.vercel.app). Nothing is signed or sent.

EXIT CODES
  0   the facts were read, whatever they are
  2   nothing could be read (the chain did not answer, or the ticker names no single token)
  64  usage error

Measured on-chain at block N. Not a trading signal.
`;

const OPTIONS: OptionSpec = {
  search: { type: "string" },
  json: { type: "boolean" },
  rpc: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export async function runStocks(argv: readonly string[], ctx: Context): Promise<number> {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(STOCKS_HELP);
    return EXIT.ok;
  }
  noExtra(positional, 1);
  const json = options.json === true;
  const search = stringOption(options.search)?.trim() || null;
  const query = positional[0];
  if (query !== undefined && search !== null) throw new UsageError("--search filters the list; give it without a ticker or address");
  const target = query === undefined ? null : stockTarget(query);
  if (target?.kind === "invalid") throw new UsageError(`${target.reason} (${query})`);
  const rpc = resolveRpc(stringOption(options.rpc), ctx.env, loadSettings(ctx.configDir));
  const requests = countRequests(ctx.fetch);
  const client = stocksClient(rpc, requests.fetch);
  const started = ctx.now();
  const render = { palette: ctx.palette, width: ctx.columns };

  if (target === null) {
    const list = await stockList(client, search);
    const line = readLine(requests.byHost(), ctx.now() - started);
    ctx.out(json ? `${JSON.stringify(stockListJson(list), null, 2)}\n` : `${renderStockList(list, { ...render, readLine: line })}\n`);
    return EXIT.ok;
  }
  if (target.kind === "unknown-ticker" || target.kind === "several") {
    printFailure(ctx, json, target.kind === "several" ? "ambiguous_ticker" : "unknown_ticker", targetProblem(target));
    return EXIT.failed;
  }
  try {
    const facts = await stockFacts(client, target, requests.fetch);
    const line = readLine(requests.byHost(), ctx.now() - started);
    ctx.out(json ? `${JSON.stringify(stockFactsJson(facts), null, 2)}\n` : `${renderStockFacts(facts, { ...render, readLine: line })}\n`);
    return EXIT.ok;
  } catch (error) {
    const host = rpc.from === "default" ? "Robinhood Chain's public endpoints" : hostOf(rpc.url);
    printFailure(ctx, json, "chain_unavailable", `the token could not be read: ${firstLine(describeError(error, host))}`);
    return EXIT.failed;
  }
}

/** viem's errors run to many lines of details; the first says what happened. */
export function firstLine(text: string): string {
  return text.split("\n")[0]!.trim();
}
