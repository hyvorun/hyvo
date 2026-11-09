/**
 * What Hyvo Board reads from Robinhood Chain on top of read.ts: curve trades from every emitter (or
 * from given curves when no endpoint answers that), launches found through the factory's own record,
 * the buys of a launch's first second, and each card's curve state and balances in Multicall3 batches.
 * Every function and event comes from pons.ts.
 */
import { getAddress, type Address } from "viem";
import type { BoardEntry } from "./board";
import { FIRST_SECOND_BLOCKS } from "./board";
import { multicall, type Read, type ReadResult } from "./multicall";
import { CURVE_ABI, ERC20_ABI, FACTORY_ABI, PONS_V2_FACTORY, TOPICS } from "./pons";
import { decodeTrades, type Snapshot, type Trade } from "./read";
import { RpcUnavailableError, type ChainReader } from "./rpc";
import { cleanName, cleanSymbol } from "./text";

const lower = (value: string) => value.toLowerCase();

function valueOf<T>(result: ReadResult | undefined): T | null {
  return result?.ok ? (result.value as T) : null;
}

/**
 * CurveBuy and CurveSell logs of [fromBlock, toBlock] from every emitter. When no endpoint answers a
 * query without an address, only `fallback` curves are asked, and `everyCurve` is false. Emitters are
 * not checked here: anyone can emit these events, so the board counts only curves it knows.
 */
export async function readTradeLogs(
  reader: ChainReader,
  fromBlock: bigint,
  toBlock: bigint,
  fallback: readonly Address[],
): Promise<{ trades: Trade[]; everyCurve: boolean }> {
  if (toBlock < fromBlock) return { trades: [], everyCurve: true };
  const topics = [[TOPICS.curveBuy, TOPICS.curveSell]];
  try {
    return { trades: decodeTrades(await reader.getLogs({ topics, fromBlock, toBlock })), everyCurve: true };
  } catch (error) {
    if (!(error instanceof RpcUnavailableError)) throw error;
    // With no curve known yet there is nothing to ask for: no trades are counted, rather than no board.
    if (fallback.length === 0) return { trades: [], everyCurve: false };
    const wanted = new Set(fallback.map(lower));
    const logs = await reader.getLogs({ address: [...fallback], topics, fromBlock, toBlock });
    return { trades: decodeTrades(logs.filter((log) => wanted.has(lower(log.address)))), everyCurve: false };
  }
}

interface LaunchRecord {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  exists: boolean;
}

/** The factory's records of `tokens`, as board entries without a launch block. Tokens it does not record are left out. */
export async function readRecords(reader: ChainReader, tokens: readonly Address[]): Promise<BoardEntry[]> {
  if (tokens.length === 0) return [];
  const answer = await multicall(
    reader,
    tokens.map((token) => ({ address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] })),
  );
  const entries: BoardEntry[] = [];
  tokens.forEach((token, i) => {
    const record = valueOf<LaunchRecord>(answer.results[i]);
    if (!record?.exists || lower(record.token) !== lower(token)) return;
    entries.push({
      token: getAddress(record.token),
      curve: getAddress(record.curve),
      creator: getAddress(record.deployer),
      pairToken: getAddress(record.pairToken),
      graduationThreshold: record.graduationThreshold,
      block: null,
      timestamp: null,
    });
  });
  return entries;
}

/**
 * The emitters among `curves` that are Pons V2 curves: the curve names the V2 factory and a token, and the
 * factory's record of that token names the emitter as its curve.
 */
export async function verifyCurves(reader: ChainReader, curves: readonly Address[]): Promise<BoardEntry[]> {
  if (curves.length === 0) return [];
  const first = await multicall(
    reader,
    curves.flatMap((curve) => [
      { address: curve, abi: CURVE_ABI, functionName: "factory" },
      { address: curve, abi: CURVE_ABI, functionName: "token" },
    ]),
  );
  const claimed = curves
    .map((curve, i) => ({ curve, factory: valueOf<Address>(first.results[i * 2]), token: valueOf<Address>(first.results[i * 2 + 1]) }))
    .filter((item): item is { curve: Address; factory: Address; token: Address } => !!item.token && !!item.factory && lower(item.factory) === lower(PONS_V2_FACTORY));
  const records = await readRecords(
    reader,
    claimed.map((item) => item.token),
  );
  return records.filter((record) => claimed.some((item) => lower(item.curve) === lower(record.curve) && lower(item.token) === lower(record.token)));
}

/** What one read of a card or a curve found; undefined: not asked, null: asked and not answered. */
export interface FactsRead {
  liquidity: bigint | null;
  graduated: boolean | null;
  symbol?: string | null;
  name?: string | null;
  launchedAt?: number | null;
  creatorTaxBps?: number | null;
  supply?: bigint | null;
  creatorBalance?: bigint | null;
  curveBalance?: bigint | null;
  /** The listed wallets' balances added up; null if any was not answered. */
  walletsBalance?: bigint | null;
}

export interface FactsRequest {
  entry: BoardEntry;
  /** Symbol, name, launch time, creator tax and supply: they do not change, so they are asked once. */
  statics: boolean;
  /** The creator's and the curve's balances, and the listed wallets'. */
  balances: boolean;
  /** The first-second wallets. Left out while they are not known, so no total is given for them. */
  wallets?: readonly Address[];
}

/** Every request's curve state, and what else it asks for, at one block. */
export async function readFacts(reader: ChainReader, requests: readonly FactsRequest[]): Promise<{ facts: Map<string, FactsRead>; read: Snapshot }> {
  const reads: Read[] = [];
  const slots: { key: string; field: keyof FactsRead | "wallet"; index: number }[] = [];
  const ask = (key: string, field: keyof FactsRead | "wallet", read: Read) => {
    slots.push({ key, field, index: reads.length });
    reads.push(read);
  };
  for (const { entry, statics, balances, wallets = [] } of requests) {
    const key = lower(entry.token);
    ask(key, "liquidity", { address: entry.curve, abi: CURVE_ABI, functionName: "realQuoteReserve" });
    ask(key, "graduated", { address: entry.curve, abi: CURVE_ABI, functionName: "graduated" });
    if (statics) {
      ask(key, "symbol", { address: entry.token, abi: ERC20_ABI, functionName: "symbol" });
      ask(key, "name", { address: entry.token, abi: ERC20_ABI, functionName: "name" });
      ask(key, "launchedAt", { address: entry.curve, abi: CURVE_ABI, functionName: "launchedAt" });
      ask(key, "creatorTaxBps", { address: entry.curve, abi: CURVE_ABI, functionName: "creatorTaxBps" });
      ask(key, "supply", { address: entry.curve, abi: CURVE_ABI, functionName: "launchSupply" });
    }
    if (balances) {
      ask(key, "creatorBalance", { address: entry.token, abi: ERC20_ABI, functionName: "balanceOf", args: [entry.creator] });
      ask(key, "curveBalance", { address: entry.token, abi: ERC20_ABI, functionName: "balanceOf", args: [entry.curve] });
      for (const wallet of wallets) ask(key, "wallet", { address: entry.token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });
    }
  }
  const answer = await multicall(reader, reads);
  const facts = new Map<string, FactsRead>();
  for (const { entry, balances, wallets } of requests) {
    facts.set(lower(entry.token), { liquidity: null, graduated: null, ...(balances && wallets ? { walletsBalance: 0n } : {}) });
  }
  for (const slot of slots) {
    const row = facts.get(slot.key)!;
    const result = answer.results[slot.index];
    switch (slot.field) {
      case "symbol":
        row.symbol = cleanSymbol(valueOf(result));
        break;
      case "name":
        row.name = cleanName(valueOf(result));
        break;
      case "launchedAt": {
        const at = valueOf<bigint>(result);
        row.launchedAt = at && at > 0n ? Number(at) : null;
        break;
      }
      case "creatorTaxBps": {
        const bps = valueOf<bigint>(result);
        row.creatorTaxBps = bps === null ? null : Number(bps);
        break;
      }
      case "graduated":
        row.graduated = valueOf<boolean>(result);
        break;
      case "wallet": {
        const amount = valueOf<bigint>(result);
        row.walletsBalance = amount === null || row.walletsBalance === null || row.walletsBalance === undefined ? null : row.walletsBalance + amount;
        break;
      }
      default:
        row[slot.field] = valueOf<bigint>(result) as never;
    }
  }
  return { facts, read: { block: answer.block, timestamp: answer.timestamp } };
}

/**
 * The buys on a launch's curve in the blocks right after its launch block, each with its block's time:
 * from the log when the endpoint adds it, else from the block's header. The caller keeps the ones of the
 * launch second (board.ts firstSecondWallets). Given the curve's `launchedAt`, headers stop at the first
 * block past it: block times never go down, so the buys after it are not of the launch second, and keep
 * no time.
 */
export async function readLaunchBuys(reader: ChainReader, entry: { curve: Address; block: bigint; launchedAt?: number }, head: bigint): Promise<Trade[]> {
  const to = entry.block + FIRST_SECOND_BLOCKS > head ? head : entry.block + FIRST_SECOND_BLOCKS;
  const logs = await reader.getLogs({ address: entry.curve, topics: [TOPICS.curveBuy], fromBlock: entry.block, toBlock: to });
  const trades = decodeTrades(logs.filter((log) => lower(log.address) === lower(entry.curve)));
  const missing = [...new Set(trades.filter((trade) => trade.timestamp === null).map((trade) => trade.block))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (missing.length === 0) return trades;
  const times = new Map<bigint, number>();
  for (const block of missing) {
    const time = (await reader.header(block)).timestamp;
    times.set(block, time);
    if (entry.launchedAt !== undefined && time > entry.launchedAt) break;
  }
  return trades.map((trade) => (trade.timestamp === null ? { ...trade, timestamp: times.get(trade.block) ?? null } : trade));
}
