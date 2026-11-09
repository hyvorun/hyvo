import { isAddress, shortenAddress } from "@hyvo/check";
import { noExtra, parseArgs, stringOption, UsageError, type OptionSpec } from "../args.js";
import type { Context } from "../context.js";
import { addToken, loadWatchlist, removeToken, saveWatchlist, watchlistPath, type Watchlist } from "../watchlist.js";
import { EXIT } from "./common.js";

export const WATCHLIST_HELP = `hyvo watchlist: the tokens hyvo watch follows, kept in a local file

USAGE
  hyvo watchlist                          Show the watchlist
  hyvo watchlist add <token> [--label <name>]
  hyvo watchlist rm <token>
  hyvo watchlist path                     Print where the file is

OPTIONS
  --label <name>   Your own name for the token, up to 40 characters
  --json           Print the result as JSON
  -h, --help       Show this help

The list holds public token addresses and stays on this machine.
`;

const OPTIONS: OptionSpec = {
  label: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function address(positional: readonly string[]): string {
  const value = positional[1];
  if (!value) throw new UsageError("missing <token>: a token address, 0x and 40 hex characters");
  noExtra(positional, 2);
  if (!isAddress(value)) throw new UsageError(`not an address: ${value} (expected 0x and 40 hex characters)`);
  return value;
}

export function runWatchlist(argv: readonly string[], ctx: Context): number {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(WATCHLIST_HELP);
    return EXIT.ok;
  }
  const json = options.json === true;
  const sub = positional[0] ?? "show";
  const dir = ctx.configDir;

  switch (sub) {
    case "show":
    case "list": {
      noExtra(positional, 1);
      const list = loadWatchlist(dir);
      ctx.out(json ? `${JSON.stringify(list, null, 2)}\n` : renderWatchlist(list, watchlistPath(dir), ctx));
      return EXIT.ok;
    }
    case "path":
      noExtra(positional, 1);
      ctx.out(`${watchlistPath(dir)}\n`);
      return EXIT.ok;
    case "add": {
      const token = address(positional);
      const label = stringOption(options.label);
      const { next, already } = addToken(loadWatchlist(dir), token, label);
      saveWatchlist(dir, next);
      const added = next.tokens.find((t) => t.toLowerCase() === token.toLowerCase())!;
      if (json) ctx.out(`${JSON.stringify({ added, label: next.labels[added] ?? null, already }, null, 2)}\n`);
      else ctx.out(already ? `  ${shortenAddress(added)} is already on the watchlist${label ? " (label updated)" : ""}\n` : `  added ${shortenAddress(added)}. hyvo watch re-checks it.\n`);
      return EXIT.ok;
    }
    case "rm":
    case "remove": {
      if (options.label !== undefined) throw new UsageError("--label goes with add");
      const token = address(positional);
      const { next, removed } = removeToken(loadWatchlist(dir), token);
      if (removed) saveWatchlist(dir, next);
      if (json) ctx.out(`${JSON.stringify({ removed: removed ? token : null }, null, 2)}\n`);
      else ctx.out(removed ? `  removed ${shortenAddress(token)}\n` : `  ${shortenAddress(token)} is not on the watchlist\n`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown watchlist command: ${sub} (show, add, rm or path)`);
  }
}

function renderWatchlist(list: Watchlist, path: string, ctx: Context): string {
  const c = ctx.palette;
  const count = list.tokens.length;
  const lines = ["", `  ${c.bold("HYVO WATCHLIST")}   ${c.gray(`${count} ${count === 1 ? "token" : "tokens"}`)}`, ""];
  if (count === 0) {
    lines.push(`  ${c.gray("Nothing yet. Add a token:")}`, `  ${c.gray("  hyvo watchlist add 0x… --label \"my token\"")}`);
  } else {
    for (const token of list.tokens) lines.push(`  ${token}${list.labels[token] ? `  ${c.bold(list.labels[token]!)}` : ""}`);
  }
  lines.push("", `  ${c.gray(`file  ${path}`)}`, `  ${c.gray("hyvo watch re-checks these tokens and prints what changes.")}`, "");
  return lines.join("\n");
}
