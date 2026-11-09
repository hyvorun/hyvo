import { Hyvo, HyvoApiError } from "@hyvo/sdk";
import { intOption, noExtra, parseArgs, stringOption, type OptionSpec } from "../args.js";
import { hostOf, loadSettings, resolveApi } from "../config.js";
import type { Context } from "../context.js";
import { renderRuns } from "../format/runs.js";
import { describeError, EXIT, printFailure, timedFetch } from "./common.js";
import { REQUEST_TIMEOUT_MS } from "./verify.js";

export const RUNS_HELP = `hyvo runs: recent published runs of Hyvo's crowd simulation

USAGE
  hyvo runs [options]

OPTIONS
  --limit <n>      How many, 1 to 50 (default 10)
  --cursor <c>     The next page, as a previous answer gave it
  --api <url>      The Hyvo API (default https://api.hyvo.run)
  --json           Print the API's answer as JSON
  -h, --help       Show this help

Each run is a synthetic crowd of AI trader agents on a private fork of Robinhood Chain, hashed and committed
on-chain. hyvo verify <runId> checks one against the chain.

Synthetic crowd reaction. Not a trading signal.
`;

const OPTIONS: OptionSpec = {
  limit: { type: "string" },
  cursor: { type: "string" },
  api: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export async function runRuns(argv: readonly string[], ctx: Context): Promise<number> {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(RUNS_HELP);
    return EXIT.ok;
  }
  noExtra(positional, 0);
  const json = options.json === true;
  const limit = intOption(options.limit, "limit", 1, 50, 10);
  const cursor = stringOption(options.cursor);
  const api = resolveApi(stringOption(options.api), ctx.env, loadSettings(ctx.configDir));
  const host = hostOf(api.url);
  const client = new Hyvo({ baseUrl: api.url, fetch: timedFetch(ctx.fetch, REQUEST_TIMEOUT_MS) });

  try {
    const list = await client.listRuns({ limit, ...(cursor ? { cursor } : {}) });
    ctx.out(json ? `${JSON.stringify(list, null, 2)}\n` : `${renderRuns(list, ctx.palette, host, ctx.columns)}\n`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof HyvoApiError) printFailure(ctx, json, error.code, `${host} answered ${error.status}: ${error.message}`);
    else if (error instanceof Error && "issues" in error) printFailure(ctx, json, "api_shape", `${host} answered in a shape this version of hyvo does not know; a newer hyvo may read it`);
    else printFailure(ctx, json, "failed", describeError(error, host));
    return EXIT.failed;
  }
}
