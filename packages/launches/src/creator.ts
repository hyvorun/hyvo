/**
 * One wallet's Pons V2 launches over the factory's whole history. TokenLaunched indexes the deployer as
 * topic 3, so a single log query by the factory's address, topic 0 and topic 3 finds every launch of one
 * wallet. The public RPC endpoints answer 10,000 to 250,000 blocks a query (docs/OPEN_ITEMS.md item 29)
 * and the factory's history is over 83 million blocks, so Hyvo's API asks Blockscout's index instead
 * (item 32). Its Etherscan-style `module=logs&action=getLogs` answers "up to a maximum of 1,000 event logs"
 * and documents no paging, so the next page starts at the highest block seen: that takes the oldest logs to
 * come first, as Etherscan's do, which is not verified yet (item 32). This module builds the query and checks
 * every log it gets back; it makes no request itself.
 */
import { decodeEventLog, getAddress, isAddress, type Address, type Hex } from "viem";
import { FACTORY_ABI, PONS_V2_FACTORY, PONS_V2_FACTORY_BLOCK, TOPICS } from "./pons";

export { PONS_V2_FACTORY, PONS_V2_FACTORY_BLOCK };

/** Blockscout answers at most this many logs to one getLogs query. */
export const LOGS_PER_PAGE = 1000;

/** One launch of the wallet, from its TokenLaunched log. */
export interface CreatorLaunch {
  token: Address;
  curve: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  block: bigint;
  /** The launch block's time in seconds, when the index gave it. */
  timestamp: number | null;
  txHash: Hex;
  logIndex: number;
}

/** An address as a 32-byte log topic. */
export function addressTopic(address: string): Hex {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as Hex;
}

/** The query string of Blockscout's getLogs for `deployer`'s launches from `fromBlock` to the newest block. */
export function creatorLogsQuery(deployer: string, fromBlock: bigint = PONS_V2_FACTORY_BLOCK): string {
  const from = fromBlock < PONS_V2_FACTORY_BLOCK ? PONS_V2_FACTORY_BLOCK : fromBlock;
  return [
    "module=logs",
    "action=getLogs",
    `address=${PONS_V2_FACTORY}`,
    `fromBlock=${from}`,
    "toBlock=latest",
    `topic0=${TOPICS.tokenLaunched}`,
    `topic3=${addressTopic(deployer)}`,
    "topic0_3_opr=and",
  ].join("&");
}

const HEX = /^0x[0-9a-fA-F]+$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

/** A quantity the index sent as hex ("0x1a") or as decimal digits; null when it is neither. */
function quantity(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return null;
  if (HEX.test(value)) return BigInt(value);
  if (/^\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * The launches in one getLogs answer. Each log must come from the V2 factory, decode as TokenLaunched and
 * name `deployer` as its deployer; anything else is dropped. `rows` counts the answer's logs before any is
 * dropped, so a caller can tell a full page (LOGS_PER_PAGE) from the last one. Null when the answer is not
 * a list of logs (an error, or a body of another shape); an empty list is "no launches".
 */
export function parseCreatorLogs(json: unknown, deployer: string): { launches: CreatorLaunch[]; rows: number } | null {
  if (!json || typeof json !== "object") return null;
  const result = (json as Record<string, unknown>).result;
  if (!Array.isArray(result)) return null;
  const wanted = deployer.toLowerCase();
  const launches: CreatorLaunch[] = [];
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const log = item as Record<string, unknown>;
    if (typeof log.address !== "string" || log.address.toLowerCase() !== PONS_V2_FACTORY.toLowerCase()) continue;
    const topics = Array.isArray(log.topics) ? log.topics.filter((topic): topic is string => typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic)) : [];
    if (topics.length !== 4 || topics[0]!.toLowerCase() !== TOPICS.tokenLaunched) continue;
    if (typeof log.data !== "string" || !HEX.test(log.data)) continue;
    const block = quantity(log.blockNumber);
    const index = quantity(log.logIndex);
    if (block === null || block < PONS_V2_FACTORY_BLOCK || typeof log.transactionHash !== "string" || !TX.test(log.transactionHash)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: FACTORY_ABI, eventName: "TokenLaunched", data: log.data as Hex, topics: topics as [Hex, ...Hex[]], strict: true });
    } catch {
      continue;
    }
    const args = decoded.args;
    if (args.deployer.toLowerCase() !== wanted) continue;
    const time = quantity(log.timeStamp);
    launches.push({
      token: getAddress(args.token),
      curve: getAddress(args.curve),
      pairToken: getAddress(args.pairToken),
      launchConfigId: args.launchConfigId,
      graduationThreshold: args.graduationThreshold,
      block,
      timestamp: time !== null && time > 0n && time < 10_000_000_000n ? Number(time) : null,
      txHash: log.transactionHash.toLowerCase() as Hex,
      logIndex: index === null ? 0 : Number(index),
    });
  }
  return { launches, rows: result.length };
}

/**
 * Pages merged: each launch once (by transaction and log), newest first. A page starts at the block the
 * previous one ended at, so the logs of that block can come twice.
 */
export function mergeCreatorPages(pages: readonly (readonly CreatorLaunch[])[]): CreatorLaunch[] {
  const seen = new Map<string, CreatorLaunch>();
  for (const page of pages) for (const launch of page) seen.set(`${launch.txHash}:${launch.logIndex}`, launch);
  return [...seen.values()].sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
}

/**
 * Where the next page starts, or null when there is none: a page with fewer than LOGS_PER_PAGE logs is the
 * last. A full page whose logs all sit in the block it started at cannot move on, so that is null too, and the
 * caller says the list may be incomplete.
 */
export function nextPageFrom(page: { launches: readonly CreatorLaunch[]; rows: number }, from: bigint): bigint | null {
  if (page.rows < LOGS_PER_PAGE) return null;
  const last = page.launches.reduce((max, launch) => (launch.block > max ? launch.block : max), 0n);
  return last > from ? last : null;
}

/** A launch as Hyvo's API sends it (`GET /v1/launches/creator/:address`): big numbers as decimal strings. */
export interface CreatorLaunchJson {
  token: string;
  curve: string;
  pairToken: string;
  launchConfigId: string;
  graduationThreshold: string;
  block: number;
  timestamp: number | null;
  txHash: string;
  logIndex: number;
}

export function creatorLaunchToJson(launch: CreatorLaunch): CreatorLaunchJson {
  return {
    token: launch.token,
    curve: launch.curve,
    pairToken: launch.pairToken,
    launchConfigId: launch.launchConfigId.toString(),
    graduationThreshold: launch.graduationThreshold.toString(),
    block: Number(launch.block),
    timestamp: launch.timestamp,
    txHash: launch.txHash,
    logIndex: launch.logIndex,
  };
}

export function creatorLaunchFromJson(json: CreatorLaunchJson): CreatorLaunch | null {
  if (!isAddress(json.token) || !isAddress(json.curve) || !isAddress(json.pairToken) || !TX.test(json.txHash)) return null;
  return {
    token: getAddress(json.token),
    curve: getAddress(json.curve),
    pairToken: getAddress(json.pairToken),
    launchConfigId: BigInt(json.launchConfigId),
    graduationThreshold: BigInt(json.graduationThreshold),
    block: BigInt(json.block),
    timestamp: json.timestamp,
    txHash: json.txHash.toLowerCase() as Hex,
    logIndex: json.logIndex,
  };
}
