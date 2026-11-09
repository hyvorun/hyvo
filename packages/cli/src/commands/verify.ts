import { existsSync, readFileSync, statSync } from "node:fs";
import { isAddress, toChecksumAddress } from "@hyvo/check";
import { noExtra, parseArgs, stringOption, UsageError, type OptionSpec } from "../args.js";
import { loadSettings, resolveApi, resolveRpc } from "../config.js";
import type { Context } from "../context.js";
import { renderVerify } from "../format/verify.js";
import { ORACLE } from "../oracle.js";
import { verifyRun, type VerifySettings, type VerifyTarget } from "../verify.js";
import { CommandError, describeError, EXIT, printFailure, timedFetch } from "./common.js";

export const VERIFY_HELP = `hyvo verify: recompute a published run's hash and compare it with its commit on Robinhood Chain

USAGE
  hyvo verify <runId> [options]
  hyvo verify <file.json> [options]     A run.json you already have; the API is not asked

OPTIONS
  --json             Print the result as JSON
  --api <url>        The Hyvo API (default https://api.hyvo.run)
  --rpc <url>        A Robinhood Chain JSON-RPC endpoint (default https://robinhood.drpc.org)
  --oracle <addr>    Read this HyvoOracle instead of the one this build pins:
                     ${ORACLE.address}
  -h, --help         Show this help

HOW
  1. Downloads the run's exact run.json bytes from the API, or reads your file.
  2. Recomputes its hash here: keccak-256 of its RFC 8785 form without the top-level "hash".
  3. Reads HyvoOracle.getCommit(runId) on Robinhood Chain through the RPC, and compares the commit's
     reportHash with that hash and its scenarioHash with the hash of the run's scenario.
  The API only says where the file is. The proof is the file and the chain.

EXIT CODES
  0   verified
  1   not verified: a hash differs, or the chain holds no commit for the run
  2   could not check (no such run, the API or the RPC did not answer)
  64  usage error

Synthetic crowd reaction. Not a trading signal.
`;

const OPTIONS: OptionSpec = {
  json: { type: "boolean" },
  api: { type: "string" },
  rpc: { type: "string" },
  oracle: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const RUN_ID = /^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 20_000;

/** A run id, or a path to a run.json. */
export function verifyTarget(arg: string): VerifyTarget {
  if (RUN_ID.test(arg)) return { runId: arg };
  if (existsSync(arg) && statSync(arg).isFile()) {
    if (statSync(arg).size > MAX_FILE_BYTES) throw new UsageError(`${arg} is larger than 64 MB`);
    return { file: { path: arg, text: readFileSync(arg, "utf8") } };
  }
  throw new UsageError(`not a run id (run_ and 26 characters) or a file: ${arg}`);
}

export function verifySettings(options: Record<string, string | boolean>, ctx: Context, signal?: AbortSignal): VerifySettings {
  const settings = loadSettings(ctx.configDir);
  const oracle = stringOption(options.oracle);
  if (oracle !== undefined && !isAddress(oracle)) throw new UsageError(`--oracle must be an address, not ${oracle}`);
  return {
    fetch: timedFetch(ctx.fetch, REQUEST_TIMEOUT_MS, signal),
    apiUrl: resolveApi(stringOption(options.api), ctx.env, settings).url,
    rpcUrl: resolveRpc(stringOption(options.rpc), ctx.env, settings).url,
    oracle: oracle === undefined ? ORACLE.address : toChecksumAddress(oracle),
    oracleFrom: oracle === undefined ? "pinned" : "option",
    chainId: ORACLE.chainId,
  };
}

export async function runVerify(argv: readonly string[], ctx: Context): Promise<number> {
  const { positional, options } = parseArgs(argv, OPTIONS);
  if (options.help) {
    ctx.out(VERIFY_HELP);
    return EXIT.ok;
  }
  const arg = positional[0];
  if (!arg) throw new UsageError("missing <runId>: a run id such as run_01M6QD9NRSBS9QDX37M1NJAEDJ, or a run.json file");
  noExtra(positional, 1);
  const json = options.json === true;
  const target = verifyTarget(arg);
  const settings = verifySettings(options, ctx);

  try {
    const report = await verifyRun(target, settings);
    ctx.out(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderVerify(report, ctx.palette, ctx.columns)}\n`);
    return report.verified ? EXIT.ok : EXIT.notVerified;
  } catch (error) {
    if (error instanceof CommandError) printFailure(ctx, json, error.code, error.message);
    else printFailure(ctx, json, "failed", describeError(error));
    return EXIT.failed;
  }
}
