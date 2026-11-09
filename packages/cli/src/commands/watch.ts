import { CheckError, isAddress, shortenAddress, toChecksumAddress, type CheckReport } from "@hyvo/check";
import { intOption, parseArgs, stringOption, UsageError, type OptionSpec } from "../args.js";
import { hostOf, loadSettings, resolveRpc } from "../config.js";
import type { Context } from "../context.js";
import { checkDisclaimer, tokenLabel } from "../format/check.js";
import { utc, wrap } from "../format/text.js";
import { countStatuses, observe, type Change, type Known } from "../watch.js";
import { loadWatchlist } from "../watchlist.js";
import { describeError, EXIT } from "./common.js";
import { parseEthIn } from "./check.js";

export const WATCH_HELP = `hyvo watch: re-check tokens on an interval and print what changed

USAGE
  hyvo watch [<token> ...] [options]      No tokens given: the ones on the watchlist

OPTIONS
  --interval <s>   Seconds between rounds, 60 to 86400 (default 300)
  --count <n>      Stop after n rounds (default: run until Ctrl+C)
  --eth-in <eth>   What each exit simulation buys with (default 0.001)
  --rpc <url>      A Robinhood Chain JSON-RPC endpoint (default https://robinhood.drpc.org)
  --json           One JSON object per line: baseline, change and error events
  -h, --help       Show this help

WHAT CHANGES COUNT
  A check whose status moves between found and not found, the owner address, the proxy implementation,
  the total supply, and the trading venue. A check that could not look this round is not a change.

Runs on this machine and only reads the chain: the same reads as hyvo check, one token after another.
Measured on-chain at one block. Not a trading signal.
`;

const OPTIONS: OptionSpec = {
  interval: { type: "string" },
  count: { type: "string" },
  "eth-in": { type: "string" },
  rpc: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const MAX_TOKENS = 20;

export async function runWatch(argv: readonly string[], ctx: Context): Promise<number> {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(WATCH_HELP);
    return EXIT.ok;
  }
  const json = options.json === true;
  const interval = intOption(options.interval, "interval", 60, 86_400, 300);
  const count = options.count === undefined ? null : intOption(options.count, "count", 1, 1_000_000, 1);
  const ethInText = stringOption(options["eth-in"]);
  const ethIn = ethInText === undefined ? undefined : parseEthIn(ethInText);
  const rpc = resolveRpc(stringOption(options.rpc), ctx.env, loadSettings(ctx.configDir));

  const list = loadWatchlist(ctx.configDir);
  for (const arg of positional) if (!isAddress(arg)) throw new UsageError(`not an address: ${arg} (expected 0x and 40 hex characters)`);
  const tokens = [...new Set((positional.length > 0 ? positional : list.tokens).map((t) => toChecksumAddress(t)))];
  if (tokens.length === 0) throw new UsageError("nothing to watch: give token addresses, or add some with hyvo watchlist add <token>");
  if (tokens.length > MAX_TOKENS) throw new UsageError(`at most ${MAX_TOKENS} tokens at once`);

  const c = ctx.palette;
  const signal = ctx.interrupt();
  const known = new Map<string, Known>();
  const at = () => new Date(ctx.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const emit = (event: Record<string, unknown>) => ctx.out(`${JSON.stringify(event)}\n`);
  const name = (token: string, report?: CheckReport) => {
    const label = list.labels[token] ?? (report ? tokenLabel(report) : null);
    return label ? `${label} ${c.gray(shortenAddress(token))}` : shortenAddress(token);
  };

  if (!json) {
    ctx.out(
      `\n  ${c.bold("HYVO WATCH")}   ${tokens.length} ${tokens.length === 1 ? "token" : "tokens"} · every ${interval} s · ${hostOf(rpc.url)}${
        count === null ? " · Ctrl+C to stop" : ` · ${count} ${count === 1 ? "round" : "rounds"}`
      }\n\n`,
    );
  }

  for (let round = 0; count === null || round < count; round++) {
    if (round > 0) await ctx.sleep(interval * 1000, signal);
    if (signal.aborted) break;
    for (const token of tokens) {
      if (signal.aborted) break;
      let report: CheckReport;
      try {
        report = await ctx.checkToken(token, {
          rpcUrls: [rpc.url],
          fetch: ctx.fetch,
          signal,
          ...(ethIn === undefined ? {} : { ethIn }),
          ...(ctx.env.HYVO_BLOCKSCOUT_KEY ? { blockscoutKey: ctx.env.HYVO_BLOCKSCOUT_KEY } : {}),
        });
      } catch (error) {
        if (signal.aborted) break;
        const code = error instanceof CheckError ? error.code : "failed";
        const message = error instanceof CheckError ? error.message : describeError(error, hostOf(rpc.url));
        if (json) emit({ event: "error", at: at(), token, code, message });
        else ctx.out(`  ${c.gray(utc(ctx.now() / 1000))}  ${name(token)}\n    ${c.gray(`could not check this round: ${message}`)}\n\n`);
        continue;
      }
      const first = !known.has(token);
      const { known: next, changes } = observe(known.get(token) ?? null, report);
      known.set(token, next);
      const disclaimer = checkDisclaimer(report.block);
      if (first) {
        const counts = countStatuses(report);
        if (json) {
          emit({
            event: "baseline",
            at: at(),
            token,
            block: report.block.toString(),
            findings: report.findings.map((f) => ({ id: f.id, status: f.status })),
            disclaimer,
          });
        } else {
          ctx.out(
            `  ${c.gray(utc(ctx.now() / 1000))}  ${name(token, report)}\n    first read at block ${report.block}: ${counts.found} found, ${counts.not_found} not found, ${counts.skipped} skipped\n    ${disclaimer}\n\n`,
          );
        }
      } else if (changes.length > 0) {
        if (json) emit({ event: "change", at: at(), token, block: report.block.toString(), changes, disclaimer });
        else ctx.out(renderChanges(`  ${c.gray(utc(ctx.now() / 1000))}  ${name(token, report)} · block ${report.block}`, changes, disclaimer, ctx));
      }
    }
  }
  if (!json) ctx.out(`  ${c.gray(signal.aborted ? "stopped." : "done.")}\n`);
  return EXIT.ok;
}

function renderChanges(head: string, changes: readonly Change[], disclaimer: string, ctx: Context): string {
  const c = ctx.palette;
  const lines = [head];
  for (const change of changes) {
    lines.push(`    ${c.bold(change.what)}: ${change.from} → ${change.to}`);
    if (change.evidence) lines.push(...wrap(change.evidence, ctx.columns, "      ").map((line) => c.gray(line)));
  }
  lines.push(`    ${disclaimer}`, "", "");
  return lines.join("\n");
}
