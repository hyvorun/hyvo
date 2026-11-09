// `hyvo launches` and the MCP tools recent_launches and launch_facts: Pons launches read from Robinhood Chain with
// @hyvo/launches, the reader and read functions the web page uses. The chain is the only source: the launch
// factory's events, then each curve's state in one Multicall3 call at one block. Nothing is signed or sent.

import {
  CALL_ENDPOINTS,
  ChainReader,
  ETH,
  LOG_ENDPOINTS,
  NATIVE,
  measurePace,
  phaseLabel,
  progress,
  readAssets,
  readCurveTrades,
  readLaunch,
  readLaunches,
  RpcUnavailableError,
  scanFactory,
  summarizeTrades,
  type Activity,
  type Asset,
  type GraduationEvent,
  type Launch,
  type LaunchDetail,
  type Lookup,
  type Snapshot,
} from "@hyvo/launches";
import type { Resolved } from "./config.js";
import { checkDisclaimer } from "./format/check.js";
import { toJson } from "./requests.js";

export const CHAIN_ID = 4663;

/** The windows `--hours` takes, as the web page offers them. */
export const WINDOW_HOURS = [1, 6, 24] as const;
export const DEFAULT_HOURS = 6;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** The trades of one curve over the last hour, as the launch's web page shows them. */
const TRADE_HOURS = 1;

const lower = (value: string) => value.toLowerCase();

/** Every URL the default reader may ask, for the help text and the README. */
export function publicEndpoints(): string[] {
  const urls = [...CALL_ENDPOINTS, ...LOG_ENDPOINTS.map((option) => (typeof option === "string" ? option : option.url))];
  return [...new Set(urls)];
}

/**
 * A reader over Robinhood Chain's public endpoints (the ones @hyvo/launches measured, each with the log span it
 * serves), or over the one RPC the user chose. A terminal has no CORS preflight to spare, so every request is
 * plain JSON.
 */
export function launchesReader(rpc: Resolved, fetchFn: typeof fetch): ChainReader {
  if (rpc.from === "default") {
    return new ChainReader({ callEndpoints: CALL_ENDPOINTS, logEndpoints: LOG_ENDPOINTS, jsonOnly: publicEndpoints(), fetch: fetchFn });
  }
  return new ChainReader({ callEndpoints: [rpc.url], logEndpoints: [rpc.url], jsonOnly: [rpc.url], fetch: fetchFn });
}

export interface PairCount {
  address: string;
  /** Null when the pair asset's decimals could not be read. */
  pair: Asset | null;
  launches: number;
}

export interface RecentLaunches {
  hours: number;
  /** The block the window ends at. */
  head: Snapshot;
  fromBlock: bigint;
  /** Launches the factory announced in the window. */
  total: number;
  graduations: GraduationEvent[];
  /** The newest of them, with their curves' state. */
  launches: Launch[];
  /** Where the curves' state was read. */
  read: Snapshot;
  byPair: PairCount[];
}

/** The launches of the last `hours`, newest first, and the state of the newest `limit` curves. */
export async function recentLaunches(reader: ChainReader, hours: number, limit: number): Promise<RecentLaunches> {
  const cache = new Map<string, Asset>();
  const top = await reader.header("latest");
  const head: Snapshot = { block: top.number, timestamp: top.timestamp };
  const pace = await measurePace(reader, head);
  const span = BigInt(Math.max(1, Math.round(hours * 3600 * pace)));
  const fromBlock = head.block - span + 1n;
  const scan = await scanFactory(reader, fromBlock, head.block);
  const { launches, read } = await readLaunches(reader, scan.launches.slice(0, limit), cache);
  // The pair assets of launches not listed, for the count by pair asset: one more call at most.
  await readAssets(
    reader,
    scan.launches.map((event) => event.pairToken),
    cache,
  );
  const counts = new Map<string, number>();
  for (const event of scan.launches) counts.set(lower(event.pairToken), (counts.get(lower(event.pairToken)) ?? 0) + 1);
  const byPair = [...counts]
    .map(([address, launches]): PairCount => ({ address, pair: address === lower(NATIVE) ? ETH : (cache.get(address) ?? null), launches }))
    .sort((a, b) => b.launches - a.launches || (a.address < b.address ? -1 : 1));
  return { hours, head, fromBlock: fromBlock < 0n ? 0n : fromBlock, total: scan.launches.length, graduations: scan.graduations, launches, read, byPair };
}

export type LastHour =
  | { status: "read"; fromBlock: bigint; toBlock: bigint; activity: Activity | null }
  | { status: "failed"; message: string }
  /** Not a Pons V2 launch: there is no curve to read. */
  | null;

export interface OneLaunch {
  token: string;
  lookup: Lookup;
  lastHour: LastHour;
}

/** One token: its Pons V2 record and curve in full and its last hour of trades, a Pons V1 note, or nothing. */
export async function oneLaunch(reader: ChainReader, token: `0x${string}`): Promise<OneLaunch> {
  const lookup = await readLaunch(reader, token, new Map());
  if (lookup.kind !== "v2") return { token, lookup, lastHour: null };
  const { read, curve } = lookup.detail;
  let lastHour: LastHour;
  try {
    const pace = await measurePace(reader, read);
    const fromBlock = read.block - BigInt(Math.max(1, Math.round(TRADE_HOURS * 3600 * pace))) + 1n;
    const trades = await readCurveTrades(reader, curve, fromBlock, read.block);
    lastHour = { status: "read", fromBlock, toBlock: read.block, activity: summarizeTrades(trades).get(lower(curve)) ?? null };
  } catch (error) {
    lastHour = { status: "failed", message: failureText(error) };
  }
  return { token, lookup, lastHour };
}

/** Plain words for a read that failed. */
export function failureText(error: unknown): string {
  if (error instanceof RpcUnavailableError) {
    const why = error.reasons.at(-1);
    return `no endpoint answered ${error.method}${why ? ` (last: ${why.slice(0, 160)})` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The phase of a listed launch, from its curve's graduated(): the list does not read the factory's record. */
export function listedPhase(launch: Pick<Launch, "graduated">): string {
  return phaseLabel(null, launch.graduated);
}

// --- JSON ---------------------------------------------------------------------------------------------------

function assetJson(asset: Asset | null) {
  return asset ? { address: asset.address, symbol: asset.symbol, name: asset.name, decimals: asset.decimals } : null;
}

export function launchJson(launch: Launch) {
  return {
    token: launch.token,
    symbol: launch.symbol,
    name: launch.name,
    pair: assetJson(launch.pair),
    launchedAt: launch.launchedAt,
    launchBlock: launch.block === null ? null : launch.block.toString(),
    launchTx: launch.txHash,
    graduated: launch.graduated,
    creatorTaxBps: launch.creatorTaxBps,
    liquidity: launch.liquidity === null ? null : launch.liquidity.toString(),
    graduationThreshold: launch.graduationThreshold.toString(),
    progress: launch.graduated ? 1 : progress(launch.liquidity, launch.graduationThreshold),
    curve: launch.curve,
    creator: launch.creator,
  };
}

/** `hyvo launches --json` and the MCP tool recent_launches. */
export function recentLaunchesJson(result: RecentLaunches) {
  return {
    chainId: CHAIN_ID,
    window: {
      hours: result.hours,
      fromBlock: result.fromBlock.toString(),
      toBlock: result.head.block.toString(),
      launches: result.total,
      graduations: result.graduations.length,
      byPair: result.byPair.map((row) => ({ address: row.address, symbol: row.pair?.symbol ?? null, launches: row.launches })),
    },
    block: result.read.block.toString(),
    timestamp: result.read.timestamp,
    launches: result.launches.map(launchJson),
    notListed: result.total - result.launches.length,
    graduations: result.graduations.map((graduation) => toJson(graduation)),
    disclaimer: checkDisclaimer(result.read.block),
  };
}

function lastHourJson(lastHour: LastHour) {
  if (lastHour === null) return null;
  if (lastHour.status === "failed") return { error: lastHour.message };
  const a = lastHour.activity;
  return {
    fromBlock: lastHour.fromBlock.toString(),
    toBlock: lastHour.toBlock.toString(),
    trades: a?.trades ?? 0,
    buys: a?.buys ?? 0,
    sells: a?.sells ?? 0,
    traders: a?.traders ?? 0,
    volume: (a?.volume ?? 0n).toString(),
    tax: (a?.tax ?? 0n).toString(),
  };
}

function detailJson(detail: LaunchDetail) {
  const { read: _read, pair, ...rest } = detail;
  return {
    ...toJson(rest),
    pair: assetJson(pair),
    phaseText: phaseLabel(detail.phase, detail.graduated),
    progress: detail.phase === "graduated" || detail.graduated === true ? 1 : progress(detail.liquidity, detail.graduationThreshold),
  };
}

/** `hyvo launches <token> --json` and the MCP tool launch_facts. */
export function oneLaunchJson(result: OneLaunch) {
  const { lookup } = result;
  const read = lookup.kind === "v2" ? lookup.detail.read : lookup.read;
  const facts =
    lookup.kind === "v2"
      ? { kind: "v2" as const, ...detailJson(lookup.detail), lastHour: lastHourJson(result.lastHour) }
      : lookup.kind === "v1"
        ? {
            kind: "v1" as const,
            token: lookup.token,
            symbol: lookup.symbol,
            name: lookup.name,
            creator: lookup.creator,
            paired: assetJson(lookup.paired),
            supply: lookup.supply.toString(),
            poolFee: lookup.poolFee,
          }
        : { kind: "none" as const, token: result.token, symbol: lookup.symbol };
  return { chainId: CHAIN_ID, ...facts, block: read.block.toString(), timestamp: read.timestamp, disclaimer: checkDisclaimer(read.block) };
}
