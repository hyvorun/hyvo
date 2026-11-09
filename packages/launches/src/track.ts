/**
 * Followed wallets and saved launches, read from Robinhood Chain for HYVO holder utilities (Track and
 * the watchlist; docs/OPEN_ITEMS.md item 33). Like the rest of this package it only reads.
 *
 * Track: a wallet's trades on Pons V2 curves are the CurveBuy and CurveSell events whose first indexed
 * address (the buyer or seller, msg.sender) or second one (the recipient) is the wallet. Measured on
 * 2026-11-10 over 10,000 blocks, 807 of 2,837 trades had a router as the first address and the person
 * as the second, so both are asked. The events come from every curve, so the query has no address:
 * of the public endpoints only Robinhood's own and degenprotocol answer one, over at most 30,000 blocks
 * (about 52 minutes at 9.6 blocks a second), which is the window Track reads.
 */
import { decodeEventLog, getAddress, isAddress, type Address, type Hex } from "viem";
import { multicall } from "./multicall";
import { CURVE_ABI, ERC20_ABI, FACTORY_ABI, NATIVE, PONS_V2_FACTORY, TOPICS, phaseFromIndex, type Phase } from "./pons";
import { readAssets, ETH, type Asset, type Snapshot } from "./read";
import type { ChainReader, RawLog } from "./rpc";
import { cleanName, cleanSymbol } from "./text";

/** The widest span a log query without an address is answered over (degenprotocol and Robinhood's endpoint, 2026-11-10). */
export const TRACK_BLOCKS = 30_000n;

/** Wallets a log query names at most: each is one topic value. */
export const MAX_TRACK_WALLETS = 25;

/** Contracts that sent the events, checked at most, so lookalike events cannot make a page do unbounded work. */
const MAX_EMITTERS = 200;

const lower = (value: string) => value.toLowerCase();

/** An address as an indexed event topic. */
export function walletTopic(address: Address): Hex {
  return `0x${lower(address).slice(2).padStart(64, "0")}` as Hex;
}

export interface WalletTrade {
  /** The followed wallet the trade belongs to. */
  wallet: Address;
  side: "buy" | "sell";
  /** The trade's msg.sender when it is not the wallet: a router, for most such trades. */
  via: Address | null;
  token: Address;
  symbol: string | null;
  curve: Address;
  pair: Asset;
  /** A buy pays `amountIn` of the pair asset (fee and tax included) for `amountOut` tokens; a sell pays tokens and gets the pair asset after fee and tax. */
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  tax: bigint;
  block: bigint;
  txHash: Hex;
  logIndex: number;
  timestamp: number | null;
}

export interface WalletTrades {
  fromBlock: bigint;
  toBlock: bigint;
  /** Newest first. */
  trades: WalletTrade[];
  /** Contracts that sent the same events and are not Pons V2 curves, left out. */
  dropped: number;
  /** Where the curves' records were read; null when no trade needed it. */
  read: Snapshot | null;
}

interface RawTrade {
  curve: Address;
  side: "buy" | "sell";
  first: Address;
  recipient: Address;
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  tax: bigint;
  block: bigint;
  txHash: Hex;
  logIndex: number;
  timestamp: number | null;
}

/** CurveBuy and CurveSell logs with both indexed addresses; logs of any other shape are dropped. */
export function decodeRawTrades(logs: readonly RawLog[]): RawTrade[] {
  const out: RawTrade[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: CURVE_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    } catch {
      continue;
    }
    const timestamp = log.blockTimestamp === undefined ? null : Number(BigInt(log.blockTimestamp)) || null;
    const common = { curve: getAddress(log.address), block: BigInt(log.blockNumber), txHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), timestamp };
    if (decoded.eventName === "CurveBuy") {
      const a = decoded.args;
      out.push({ ...common, side: "buy", first: a.buyer, recipient: a.recipient, amountIn: a.quoteIn, amountOut: a.tokensOut, fee: a.fee, tax: a.tax });
    } else if (decoded.eventName === "CurveSell") {
      const a = decoded.args;
      out.push({ ...common, side: "sell", first: a.seller, recipient: a.recipient, amountIn: a.tokensIn, amountOut: a.quoteOut, fee: a.fee, tax: a.tax });
    }
  }
  return out;
}

interface CurveRecord {
  token: Address;
  curve: Address;
  pairToken: Address;
  symbol: string | null;
}

/**
 * The Pons V2 curves among `emitters`: a contract counts when it names the V2 factory and a token, and
 * the factory's record of that token names it as the curve. Anyone can emit an event named CurveBuy.
 */
async function verifyCurves(reader: ChainReader, emitters: readonly Address[], cache: Map<string, Asset>): Promise<{ curves: Map<string, CurveRecord>; read: Snapshot | null }> {
  const curves = new Map<string, CurveRecord>();
  if (emitters.length === 0) return { curves, read: null };
  const first = await multicall(
    reader,
    emitters.flatMap((curve) => [
      { address: curve, abi: CURVE_ABI, functionName: "factory" },
      { address: curve, abi: CURVE_ABI, functionName: "token" },
    ]),
  );
  const claimed = emitters
    .map((curve, i) => ({ curve, factory: valueOf<Address>(first.results[i * 2]), token: valueOf<Address>(first.results[i * 2 + 1]) }))
    .filter((item): item is { curve: Address; factory: Address; token: Address } => !!item.factory && !!item.token && lower(item.factory) === lower(PONS_V2_FACTORY));
  if (claimed.length === 0) return { curves, read: { block: first.block, timestamp: first.timestamp } };
  const second = await multicall(
    reader,
    claimed.flatMap((item) => [
      { address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [item.token] },
      { address: item.token, abi: ERC20_ABI, functionName: "symbol" },
    ]),
  );
  claimed.forEach((item, i) => {
    const record = valueOf<{ token: Address; curve: Address; pairToken: Address; exists: boolean }>(second.results[i * 2]);
    if (!record?.exists || lower(record.curve) !== lower(item.curve) || lower(record.token) !== lower(item.token)) return;
    curves.set(lower(item.curve), { token: record.token, curve: record.curve, pairToken: record.pairToken, symbol: cleanSymbol(valueOf(second.results[i * 2 + 1])) });
  });
  await readAssets(
    reader,
    [...curves.values()].map((record) => record.pairToken),
    cache,
  );
  return { curves, read: second.block < first.block ? { block: second.block, timestamp: second.timestamp } : { block: first.block, timestamp: first.timestamp } };
}

/**
 * The Pons V2 curve trades of `wallets` in [fromBlock, toBlock]: two log queries without an address,
 * one for the wallets as buyer or seller and one for them as recipient.
 */
export async function readWalletTrades(
  reader: ChainReader,
  options: { wallets: readonly Address[]; fromBlock: bigint; toBlock: bigint; cache: Map<string, Asset> },
): Promise<WalletTrades> {
  const { fromBlock, toBlock, cache } = options;
  const wallets = [...new Map(options.wallets.filter((wallet) => isAddress(wallet, { strict: false })).map((wallet) => [lower(wallet), wallet])).values()].slice(0, MAX_TRACK_WALLETS);
  if (wallets.length === 0) return { fromBlock, toBlock, trades: [], dropped: 0, read: null };
  const kinds = [TOPICS.curveBuy, TOPICS.curveSell];
  const values = wallets.map(walletTopic);
  const [asSender, asRecipient] = await Promise.all([
    reader.getLogs({ topics: [kinds, values], fromBlock, toBlock }),
    reader.getLogs({ topics: [kinds, null, values], fromBlock, toBlock }),
  ]);
  const seen = new Set<string>();
  const followed = new Map(wallets.map((wallet) => [lower(wallet), getAddress(wallet)]));
  const raw = decodeRawTrades([...asSender, ...asRecipient]).filter((trade) => {
    const key = `${trade.txHash}:${trade.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return followed.has(lower(trade.first)) || followed.has(lower(trade.recipient));
  });
  const emitters = [...new Map(raw.map((trade) => [lower(trade.curve), trade.curve])).values()].slice(0, MAX_EMITTERS);
  const { curves, read } = await verifyCurves(reader, emitters, cache);
  const trades: WalletTrade[] = [];
  let dropped = 0;
  const droppedCurves = new Set<string>();
  for (const trade of raw) {
    const record = curves.get(lower(trade.curve));
    const pair = record ? (lower(record.pairToken) === lower(NATIVE) ? ETH : cache.get(lower(record.pairToken))) : undefined;
    if (!record || !pair) {
      if (!droppedCurves.has(lower(trade.curve))) {
        droppedCurves.add(lower(trade.curve));
        dropped += 1;
      }
      continue;
    }
    const wallet = followed.get(lower(trade.first)) ?? followed.get(lower(trade.recipient))!;
    trades.push({
      wallet,
      side: trade.side,
      via: lower(trade.first) === lower(wallet) ? null : getAddress(trade.first),
      token: record.token,
      symbol: record.symbol,
      curve: record.curve,
      pair,
      amountIn: trade.amountIn,
      amountOut: trade.amountOut,
      fee: trade.fee,
      tax: trade.tax,
      block: trade.block,
      txHash: trade.txHash,
      logIndex: trade.logIndex,
      timestamp: trade.timestamp,
    });
  }
  trades.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
  return { fromBlock, toBlock, trades, dropped, read };
}

/** One saved launch, as the watchlist shows it now. */
export type WatchItem =
  | {
      kind: "v2";
      token: Address;
      symbol: string | null;
      name: string | null;
      pair: Asset;
      phase: Phase | null;
      graduated: boolean | null;
      liquidity: bigint | null;
      graduationThreshold: bigint;
      creatorTaxBps: number;
    }
  | { kind: "none"; token: Address; symbol: string | null; name: string | null };

/** Saved launches read at one block: the factory's record, the token's symbol and name, and the curve's state. */
export async function readWatchlist(reader: ChainReader, tokens: readonly Address[], cache: Map<string, Asset>): Promise<{ items: WatchItem[]; read: Snapshot }> {
  const list = tokens.filter((token) => isAddress(token, { strict: false }));
  const first = await multicall(
    reader,
    list.flatMap((token) => [
      { address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] },
      { address: token, abi: ERC20_ABI, functionName: "symbol" },
      { address: token, abi: ERC20_ABI, functionName: "name" },
    ]),
  );
  type Record = { token: Address; curve: Address; pairToken: Address; graduationThreshold: bigint; creatorTaxBps: number; phase: number; exists: boolean };
  const records = list.map((token, i) => {
    const record = valueOf<Record>(first.results[i * 3]);
    return record?.exists && lower(record.token) === lower(token) ? record : null;
  });
  const curves = records.filter((record): record is Record => record !== null);
  await readAssets(
    reader,
    curves.map((record) => record.pairToken),
    cache,
  );
  const second =
    curves.length > 0
      ? await multicall(
          reader,
          curves.flatMap((record) => [
            { address: record.curve, abi: CURVE_ABI, functionName: "realQuoteReserve" },
            { address: record.curve, abi: CURVE_ABI, functionName: "graduated" },
          ]),
        )
      : null;
  const state = new Map(curves.map((record, i) => [lower(record.curve), { liquidity: valueOf<bigint>(second?.results[i * 2]), graduated: valueOf<boolean>(second?.results[i * 2 + 1]) }]));
  const items = list.map((token, i): WatchItem => {
    const symbol = cleanSymbol(valueOf(first.results[i * 3 + 1]));
    const name = cleanName(valueOf(first.results[i * 3 + 2]));
    const record = records[i];
    const pair = record ? (lower(record.pairToken) === lower(NATIVE) ? ETH : cache.get(lower(record.pairToken))) : undefined;
    if (!record || !pair) return { kind: "none", token: getAddress(token), symbol, name };
    const curve = state.get(lower(record.curve));
    return {
      kind: "v2",
      token: record.token,
      symbol,
      name,
      pair,
      phase: phaseFromIndex(Number(record.phase)),
      graduated: curve?.graduated ?? null,
      liquidity: curve?.liquidity ?? null,
      graduationThreshold: record.graduationThreshold,
      creatorTaxBps: Number(record.creatorTaxBps),
    };
  });
  const read = second && second.block < first.block ? { block: second.block, timestamp: second.timestamp } : { block: first.block, timestamp: first.timestamp };
  return { items, read };
}

function valueOf<T>(result: { ok: boolean; value?: unknown } | undefined): T | null {
  return result && result.ok ? ((result as { value: unknown }).value as T) : null;
}
