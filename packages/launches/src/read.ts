/**
 * What Hyvo Launches reads from Robinhood Chain: the launches the Pons V2 factory announced in a
 * block range, the state of each launch's bonding curve, the trades on the curves, and one launch in
 * full. Every fact comes with the block it was read at.
 */
import { decodeEventLog, getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { multicall, type Read, type ReadResult } from "./multicall";
import { CURVE_ABI, ERC20_ABI, FACTORY_ABI, NATIVE, PONS_V1_FACTORY, PONS_V2_FACTORY, PONS_V2_FACTORY_BLOCK, TOPICS, V1_FACTORY_ABI, phaseFromIndex, type Phase } from "./pons";
import { RpcUnavailableError, type ChainReader, type RawLog } from "./rpc";
import { cleanName, cleanSymbol } from "./text";

export interface Asset {
  /** NATIVE for ETH. */
  address: Address;
  symbol: string | null;
  name: string | null;
  decimals: number;
}

export const ETH: Asset = { address: NATIVE, symbol: "ETH", name: "Ether", decimals: 18 };

/** The block a set of facts was read at, and its time in seconds. */
export interface Snapshot {
  block: bigint;
  timestamp: number;
}

export interface LaunchEvent {
  token: Address;
  curve: Address;
  /** The `deployer` of TokenLaunched: the address Pons records as the creator. */
  creator: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  block: bigint;
  txHash: Hex;
  logIndex: number;
  timestamp: number | null;
}

export interface GraduationEvent {
  token: Address;
  positionId: bigint;
  tokenAmount: bigint;
  pairTokenAmount: bigint;
  block: bigint;
  txHash: Hex;
  timestamp: number | null;
}

/** One launch as a list shows it. */
export interface Launch {
  token: Address;
  curve: Address;
  creator: Address;
  pair: Asset;
  symbol: string | null;
  name: string | null;
  /** When trading opened, in seconds (the curve's launchedAt). */
  launchedAt: number | null;
  /** The launch's block and transaction, when the launch event was read. */
  block: bigint | null;
  txHash: Hex | null;
  creatorTaxBps: number | null;
  graduated: boolean | null;
  /** Pair asset the curve holds for trading, in its smallest unit (realQuoteReserve). */
  liquidity: bigint | null;
  graduationThreshold: bigint;
}

export interface Trade {
  curve: Address;
  side: "buy" | "sell";
  /** The recipient: the first indexed address is msg.sender, a router for most trades. */
  trader: Address;
  /** Pair asset that changed hands before fee and tax, in its smallest unit. */
  quote: bigint;
  tokens: bigint;
  fee: bigint;
  tax: bigint;
  block: bigint;
  txHash: Hex;
  logIndex: number;
  timestamp: number | null;
}

export interface Activity {
  curve: Address;
  trades: number;
  buys: number;
  sells: number;
  traders: number;
  volume: bigint;
  tax: bigint;
  lastBlock: bigint;
  lastTimestamp: number | null;
}

const lower = (address: string) => address.toLowerCase();
const num = (value: Hex | undefined) => (value === undefined ? null : Number(BigInt(value)));

/** The launches and graduations the V2 factory announced in [fromBlock, toBlock]. Anything else is dropped. */
export async function scanFactory(reader: ChainReader, fromBlock: bigint, toBlock: bigint): Promise<{ launches: LaunchEvent[]; graduations: GraduationEvent[] }> {
  const from = fromBlock < PONS_V2_FACTORY_BLOCK ? PONS_V2_FACTORY_BLOCK : fromBlock;
  const logs = await reader.getLogs({ address: PONS_V2_FACTORY, topics: [[TOPICS.tokenLaunched, TOPICS.poolGraduated]], fromBlock: from, toBlock });
  return decodeFactoryLogs(logs, from, toBlock);
}

export function decodeFactoryLogs(logs: readonly RawLog[], fromBlock: bigint, toBlock: bigint): { launches: LaunchEvent[]; graduations: GraduationEvent[] } {
  const launches: LaunchEvent[] = [];
  const graduations: GraduationEvent[] = [];
  for (const log of logs) {
    if (lower(log.address) !== lower(PONS_V2_FACTORY)) continue;
    const block = BigInt(log.blockNumber);
    if (block < fromBlock || block > toBlock) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    } catch {
      continue;
    }
    const timestamp = num(log.blockTimestamp);
    if (decoded.eventName === "TokenLaunched") {
      const args = decoded.args;
      launches.push({
        token: args.token,
        curve: args.curve,
        creator: args.deployer,
        pairToken: args.pairToken,
        launchConfigId: args.launchConfigId,
        graduationThreshold: args.graduationThreshold,
        block,
        txHash: log.transactionHash,
        logIndex: Number(BigInt(log.logIndex)),
        timestamp: timestamp && timestamp > 0 ? timestamp : null,
      });
    } else if (decoded.eventName === "PoolGraduated") {
      const args = decoded.args;
      graduations.push({
        token: args.token,
        positionId: args.positionId,
        tokenAmount: args.tokenAmount,
        pairTokenAmount: args.pairTokenAmount,
        block,
        txHash: log.transactionHash,
        timestamp: timestamp && timestamp > 0 ? timestamp : null,
      });
    }
  }
  // Newest first.
  launches.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
  graduations.sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
  return { launches, graduations };
}

/** The pair assets among `addresses` that are not in `cache` yet, and the reads that describe them. */
function assetReads(addresses: readonly Address[], cache: Map<string, Asset>): { unknown: string[]; reads: Read[] } {
  const unknown = [...new Set(addresses.map(lower))].filter((address) => address !== lower(NATIVE) && !cache.has(address));
  const reads: Read[] = unknown.flatMap((address) => [
    { address: address as Address, abi: ERC20_ABI, functionName: "symbol" },
    { address: address as Address, abi: ERC20_ABI, functionName: "name" },
    { address: address as Address, abi: ERC20_ABI, functionName: "decimals" },
  ]);
  return { unknown, reads };
}

function keepAssets(unknown: readonly string[], results: readonly ReadResult[], cache: Map<string, Asset>): void {
  unknown.forEach((address, i) => {
    const [symbol, name, decimals] = results.slice(i * 3, i * 3 + 3);
    const places = valueOf<number>(decimals);
    // A pair asset without readable decimals cannot be shown in its own units; 18 would be a guess.
    if (places === null) return;
    cache.set(address, { address: getAddress(address), symbol: cleanSymbol(valueOf(symbol)), name: cleanName(valueOf(name)), decimals: Number(places) });
  });
}

/** Symbol, name and decimals of pair assets, read once per address and kept in `cache`. */
export async function readAssets(reader: ChainReader, addresses: readonly Address[], cache: Map<string, Asset>): Promise<void> {
  const { unknown, reads } = assetReads(addresses, cache);
  if (unknown.length === 0) return;
  const { results } = await multicall(reader, reads);
  keepAssets(unknown, results, cache);
}

function assetFor(pairToken: Address, cache: Map<string, Asset>): Asset | null {
  if (lower(pairToken) === lower(NATIVE)) return ETH;
  return cache.get(lower(pairToken)) ?? null;
}

function valueOf<T>(result: ReadResult | undefined): T | null {
  return result?.ok ? (result.value as T) : null;
}

const LIST_READS = ["symbol", "name", "realQuoteReserve", "launchedAt", "creatorTaxBps", "graduated"] as const;

/** The state of each launch's curve, and any pair asset not known yet, in as few calls as Multicall3 allows. */
export async function readLaunches(reader: ChainReader, events: readonly LaunchEvent[], cache: Map<string, Asset>): Promise<{ launches: Launch[]; read: Snapshot }> {
  const assets = assetReads(
    events.map((event) => event.pairToken),
    cache,
  );
  const reads: Read[] = events.flatMap((event) => [
    { address: event.token, abi: ERC20_ABI, functionName: "symbol" },
    { address: event.token, abi: ERC20_ABI, functionName: "name" },
    { address: event.curve, abi: CURVE_ABI, functionName: "realQuoteReserve" },
    { address: event.curve, abi: CURVE_ABI, functionName: "launchedAt" },
    { address: event.curve, abi: CURVE_ABI, functionName: "creatorTaxBps" },
    { address: event.curve, abi: CURVE_ABI, functionName: "graduated" },
  ]);
  const answer = await multicall(reader, [...reads, ...assets.reads]);
  keepAssets(assets.unknown, answer.results.slice(reads.length), cache);
  const launches: Launch[] = [];
  events.forEach((event, i) => {
    const pair = assetFor(event.pairToken, cache);
    if (!pair) return;
    const at = (name: (typeof LIST_READS)[number]) => answer.results[i * LIST_READS.length + LIST_READS.indexOf(name)];
    const launchedAt = valueOf<bigint>(at("launchedAt"));
    const tax = valueOf<bigint>(at("creatorTaxBps"));
    launches.push({
      token: event.token,
      curve: event.curve,
      creator: event.creator,
      pair,
      symbol: cleanSymbol(valueOf(at("symbol"))),
      name: cleanName(valueOf(at("name"))),
      launchedAt: launchedAt && launchedAt > 0n ? Number(launchedAt) : event.timestamp,
      block: event.block,
      txHash: event.txHash,
      creatorTaxBps: tax === null ? null : Number(tax),
      graduated: valueOf<boolean>(at("graduated")),
      liquidity: valueOf<bigint>(at("realQuoteReserve")),
      graduationThreshold: event.graduationThreshold,
    });
  });
  return { launches, read: { block: answer.block, timestamp: answer.timestamp } };
}

/** CurveBuy and CurveSell logs, decoded. Logs of any other shape are dropped. */
export function decodeTrades(logs: readonly RawLog[]): Trade[] {
  const trades: Trade[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: CURVE_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    } catch {
      continue;
    }
    const common = {
      curve: getAddress(log.address),
      block: BigInt(log.blockNumber),
      txHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      timestamp: num(log.blockTimestamp) || null,
    };
    if (decoded.eventName === "CurveBuy") {
      const a = decoded.args;
      // quoteIn is what the buyer spent, fee and tax included (PonsV2BondingCurve.buy).
      trades.push({ ...common, side: "buy", trader: a.recipient, quote: a.quoteIn, tokens: a.tokensOut, fee: a.fee, tax: a.tax });
    } else if (decoded.eventName === "CurveSell") {
      const a = decoded.args;
      // quoteOut is what the seller received after fee and tax (PonsV2BondingCurve.sell).
      trades.push({ ...common, side: "sell", trader: a.recipient, quote: a.quoteOut + a.fee + a.tax, tokens: a.tokensIn, fee: a.fee, tax: a.tax });
    }
  }
  return trades;
}

/** Trades per curve: counts, distinct traders, volume and creator tax, all in the pair asset. */
export function summarizeTrades(trades: readonly Trade[]): Map<string, Activity> {
  const byCurve = new Map<string, Activity & { people: Set<string> }>();
  for (const trade of trades) {
    const key = lower(trade.curve);
    let row = byCurve.get(key);
    if (!row) {
      row = { curve: trade.curve, trades: 0, buys: 0, sells: 0, traders: 0, volume: 0n, tax: 0n, lastBlock: 0n, lastTimestamp: null, people: new Set() };
      byCurve.set(key, row);
    }
    row.trades += 1;
    if (trade.side === "buy") row.buys += 1;
    else row.sells += 1;
    row.people.add(lower(trade.trader));
    row.volume += trade.quote;
    row.tax += trade.tax;
    if (trade.block >= row.lastBlock) {
      row.lastBlock = trade.block;
      row.lastTimestamp = trade.timestamp ?? row.lastTimestamp;
    }
  }
  const out = new Map<string, Activity>();
  for (const [key, { people, ...row }] of byCurve) out.set(key, { ...row, traders: people.size });
  return out;
}

/** Most trades first, then most traders, then the most recent. */
export function rankActivity(activity: Iterable<Activity>): Activity[] {
  return [...activity].sort((a, b) => b.trades - a.trades || b.traders - a.traders || (a.lastBlock === b.lastBlock ? 0 : a.lastBlock > b.lastBlock ? -1 : 1));
}

export interface Movers {
  fromBlock: bigint;
  toBlock: bigint;
  /** The busiest verified curves, busiest first. */
  rows: { launch: Launch; activity: Activity }[];
  /** Curves that traded in the window and are Pons V2 curves. */
  curves: number;
  trades: number;
  buys: number;
  sells: number;
  /** Emitters of the same events that are not Pons V2 curves, left out. */
  dropped: number;
  /** False when only the given launches' curves could be read (no endpoint answered a query without an address). */
  everyCurve: boolean;
  /** Where the state of curves outside `known` was read; null when there were none. */
  read: Snapshot | null;
}

/** Emitters checked at most, so a flood of lookalike events cannot make the page do unbounded work. */
const MAX_EMITTERS = 300;

/**
 * The curves with the most trades in [fromBlock, toBlock]. A CurveBuy or CurveSell log counts only
 * when its emitter is a curve the V2 factory records for its token: anyone can emit an event with
 * the same signature.
 */
export async function readMovers(
  reader: ChainReader,
  options: { fromBlock: bigint; toBlock: bigint; known: readonly Launch[]; limit: number; cache: Map<string, Asset> },
): Promise<Movers> {
  const { fromBlock, toBlock, known, limit, cache } = options;
  const topics = [[TOPICS.curveBuy, TOPICS.curveSell]];
  let logs: RawLog[];
  let everyCurve = true;
  try {
    logs = await reader.getLogs({ topics, fromBlock, toBlock });
  } catch (error) {
    if (!(error instanceof RpcUnavailableError) || known.length === 0) throw error;
    everyCurve = false;
    logs = await reader.getLogs({ address: known.slice(0, 40).map((launch) => launch.curve), topics, fromBlock, toBlock });
  }
  const ranked = rankActivity(summarizeTrades(decodeTrades(logs)).values()).slice(0, MAX_EMITTERS);
  const knownByCurve = new Map(known.map((launch) => [lower(launch.curve), launch]));

  // Every emitter that is not a launch already read is checked three ways: the factory it names,
  // the token it names, and the factory's own record of that token's curve.
  const strangers = ranked.filter((row) => !knownByCurve.has(lower(row.curve)));
  const curvesOk = new Set<string>();
  const verified = new Map<string, Launch>();
  let read: Snapshot | null = null;
  if (strangers.length > 0) {
    const first = await multicall(
      reader,
      strangers.flatMap((row) => [
        { address: row.curve, abi: CURVE_ABI, functionName: "factory" },
        { address: row.curve, abi: CURVE_ABI, functionName: "token" },
      ]),
    );
    read = { block: first.block, timestamp: first.timestamp };
    const claimed = strangers
      .map((row, i) => ({ row, factory: valueOf<Address>(first.results[i * 2]), token: valueOf<Address>(first.results[i * 2 + 1]) }))
      .filter((item): item is { row: Activity; factory: Address; token: Address } => !!item.factory && !!item.token && lower(item.factory) === lower(PONS_V2_FACTORY));
    if (claimed.length > 0) {
      const records = await multicall(
        reader,
        claimed.map((item) => ({ address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [item.token] })),
      );
      const events: LaunchEvent[] = [];
      claimed.forEach((item, i) => {
        const record = valueOf<LaunchedTokenRecord>(records.results[i]);
        if (!record?.exists || lower(record.curve) !== lower(item.row.curve) || lower(record.token) !== lower(item.token)) return;
        events.push({
          token: record.token,
          curve: record.curve,
          creator: record.deployer,
          pairToken: record.pairToken,
          launchConfigId: 0n,
          graduationThreshold: record.graduationThreshold,
          block: 0n,
          txHash: "0x",
          logIndex: 0,
          timestamp: null,
        });
      });
      // Only the rows that will show need their state.
      const needed = new Set(
        ranked
          .filter((row) => knownByCurve.has(lower(row.curve)) || events.some((event) => lower(event.curve) === lower(row.curve)))
          .slice(0, limit)
          .map((row) => lower(row.curve)),
      );
      for (const event of events) curvesOk.add(lower(event.curve));
      const shown = events.filter((event) => needed.has(lower(event.curve)));
      if (shown.length > 0) {
        const answer = await readLaunches(reader, shown, cache);
        read = answer.read;
        for (const launch of answer.launches) verified.set(lower(launch.curve), { ...launch, block: null, txHash: null });
      }
    }
  }
  const rows: { launch: Launch; activity: Activity }[] = [];
  const totals = { curves: 0, trades: 0, buys: 0, sells: 0, dropped: 0 };
  for (const activity of ranked) {
    const key = lower(activity.curve);
    if (!knownByCurve.has(key) && !curvesOk.has(key)) {
      totals.dropped += 1;
      continue;
    }
    totals.curves += 1;
    totals.trades += activity.trades;
    totals.buys += activity.buys;
    totals.sells += activity.sells;
    const launch = knownByCurve.get(key) ?? verified.get(key);
    if (launch && rows.length < limit) rows.push({ launch, activity });
  }
  return { fromBlock, toBlock, rows, ...totals, everyCurve, read };
}

interface LaunchedTokenRecord {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: bigint;
  exists: boolean;
}

interface V1Record {
  token: Address;
  deployer: Address;
  pairedToken: Address;
  supply: bigint;
  poolFee: number;
  exists: boolean;
}

export interface LaunchDetail {
  token: Address;
  curve: Address;
  creator: Address;
  feeRecipient: Address;
  symbol: string | null;
  name: string | null;
  pair: Asset;
  phase: Phase | null;
  graduated: boolean | null;
  feeBps: number | null;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  graduationThreshold: bigint;
  liquidity: bigint | null;
  launchedAt: number | null;
  supply: bigint | null;
  reserved: bigint | null;
  sellable: bigint | null;
  snipeTaxStartBps: number | null;
  snipeTaxSeconds: number | null;
  /** The Uniswap V4 pool's tick spacing, fixed at launch. */
  tickSpacing: number;
  read: Snapshot;
}

export type Lookup =
  | { kind: "v2"; detail: LaunchDetail }
  | { kind: "v1"; token: Address; symbol: string | null; name: string | null; creator: Address; paired: Asset | null; supply: bigint; poolFee: number; read: Snapshot }
  | { kind: "none"; symbol: string | null; read: Snapshot };

const DETAIL_READS = [
  "feeBps",
  "realQuoteReserve",
  "graduated",
  "launchedAt",
  "launchSupply",
  "reservedTokens",
  "sellableTokens",
  "snipeTaxStartBps",
  "snipeTaxSeconds",
] as const;

/** One token: its Pons V2 record and curve in full, a short note for a V1 token, or nothing. */
export async function readLaunch(reader: ChainReader, token: Address, cache: Map<string, Asset>): Promise<Lookup> {
  if (!isAddress(token) || lower(token) === lower(zeroAddress)) throw new Error("not an address");
  const first = await multicall(reader, [
    { address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] },
    { address: PONS_V1_FACTORY, abi: V1_FACTORY_ABI, functionName: "getLaunchedToken", args: [token] },
    { address: token, abi: ERC20_ABI, functionName: "symbol" },
    { address: token, abi: ERC20_ABI, functionName: "name" },
  ]);
  const read = { block: first.block, timestamp: first.timestamp };
  const record = valueOf<LaunchedTokenRecord>(first.results[0]);
  const symbol = cleanSymbol(valueOf(first.results[2]));
  const name = cleanName(valueOf(first.results[3]));
  if (!record?.exists || lower(record.token) !== lower(token)) {
    const v1 = valueOf<V1Record>(first.results[1]);
    if (v1?.exists && lower(v1.token) === lower(token)) {
      await readAssets(reader, [v1.pairedToken], cache);
      return { kind: "v1", token: getAddress(token), symbol, name, creator: v1.deployer, paired: assetFor(v1.pairedToken, cache), supply: v1.supply, poolFee: Number(v1.poolFee), read };
    }
    return { kind: "none", symbol, read };
  }
  await readAssets(reader, [record.pairToken], cache);
  const pair = assetFor(record.pairToken, cache);
  if (!pair) throw new Error("The pair asset's decimals could not be read.");
  const second = await multicall(
    reader,
    DETAIL_READS.map((functionName) => ({ address: record.curve, abi: CURVE_ABI, functionName })),
  );
  const at = (name: (typeof DETAIL_READS)[number]) => second.results[DETAIL_READS.indexOf(name)];
  const big = (name: (typeof DETAIL_READS)[number]) => valueOf<bigint>(at(name));
  const small = (name: (typeof DETAIL_READS)[number]) => {
    const value = big(name);
    return value === null ? null : Number(value);
  };
  const launchedAt = big("launchedAt");
  return {
    kind: "v2",
    detail: {
      token: record.token,
      curve: record.curve,
      creator: record.deployer,
      feeRecipient: record.creatorFeeRecipient,
      symbol,
      name,
      pair,
      phase: phaseFromIndex(Number(record.phase)),
      graduated: valueOf<boolean>(at("graduated")),
      feeBps: small("feeBps"),
      creatorTaxBps: Number(record.creatorTaxBps),
      buybackEnabled: record.buybackEnabled,
      graduationThreshold: record.graduationThreshold,
      liquidity: big("realQuoteReserve"),
      launchedAt: launchedAt && launchedAt > 0n ? Number(launchedAt) : null,
      supply: big("launchSupply"),
      reserved: big("reservedTokens"),
      sellable: big("sellableTokens"),
      snipeTaxStartBps: small("snipeTaxStartBps"),
      snipeTaxSeconds: small("snipeTaxSeconds"),
      tickSpacing: Number(record.tickSpacing),
      read: second.block < read.block ? { block: second.block, timestamp: second.timestamp } : read,
    },
  };
}

/** The trades on one curve in [fromBlock, toBlock], oldest first. */
export async function readCurveTrades(reader: ChainReader, curve: Address, fromBlock: bigint, toBlock: bigint): Promise<Trade[]> {
  const logs = await reader.getLogs({ address: curve, topics: [[TOPICS.curveBuy, TOPICS.curveSell]], fromBlock, toBlock });
  return decodeTrades(logs.filter((log) => lower(log.address) === lower(curve)));
}

/**
 * The launch event of one token. Its block is not stored on chain, but its time is: the curve's
 * launchedAt is the launch block's time. So the block is found from block times (a guess from the
 * chain's pace, corrected against the time of the guessed block a few times), and the event is
 * looked for around it, then a little wider.
 */
export async function findLaunchEvent(
  reader: ChainReader,
  token: Address,
  options: { launchedAt: number; head: Snapshot; blocksPerSecond: number },
): Promise<LaunchEvent | null> {
  const { launchedAt, head, blocksPerSecond } = options;
  let guess = head.block - BigInt(Math.max(0, Math.round((head.timestamp - launchedAt) * blocksPerSecond)));
  for (let step = 0; step < 4; step++) {
    if (guess < PONS_V2_FACTORY_BLOCK) guess = PONS_V2_FACTORY_BLOCK;
    if (guess > head.block) guess = head.block;
    const seen = await reader.header(guess);
    const off = launchedAt - seen.timestamp;
    if (Math.abs(off) <= 5) break;
    guess += BigInt(Math.round(off * blocksPerSecond));
  }
  const tokenTopic = `0x${lower(token).slice(2).padStart(64, "0")}` as Hex;
  for (const reach of [20_000n, 200_000n]) {
    const from = guess - reach < PONS_V2_FACTORY_BLOCK ? PONS_V2_FACTORY_BLOCK : guess - reach;
    const to = guess + reach > head.block ? head.block : guess + reach;
    if (to < from) continue;
    const logs = await reader.getLogs({ address: PONS_V2_FACTORY, topics: [TOPICS.tokenLaunched, tokenTopic], fromBlock: from, toBlock: to });
    const found = decodeFactoryLogs(logs, from, to).launches.find((event) => lower(event.token) === lower(token));
    if (found) return found;
  }
  return null;
}

/** Blocks per second over the last `span` blocks, from two block headers. */
export async function measurePace(reader: ChainReader, head: Snapshot, span = 200_000n): Promise<number> {
  const earlier = await reader.header(head.block - span);
  const seconds = head.timestamp - earlier.timestamp;
  if (seconds <= 0) throw new Error("block times did not move forward");
  return Number(head.block - earlier.number) / seconds;
}
