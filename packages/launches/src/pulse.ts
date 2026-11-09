/**
 * Chain Pulse: the last hours of Pons V2 launches, counted from the launches a page has already read.
 * Facts only: how many launches chose each pair asset and where each one trades now, the creator tax
 * each set at launch, how many curves graduated, and which launches share a symbol or a name with
 * another launch of the same hours. Nothing here rates a launch: a shared symbol is a count, not a
 * judgment of either token.
 *
 * Where a launch trades follows the factory's verified source (PonsV2LaunchFactory.sol): a curve's
 * `graduated()` turns true when it is swept, and the factory emits `PoolGraduated` right after it
 * creates the token's Uniswap V4 pool and locks its position.
 */
import { NATIVE } from "./pons";
import { ETH, type Asset, type GraduationEvent, type Launch, type LaunchEvent } from "./read";
import { NAME_MAX, SYMBOL_MAX, wasCut } from "./text";

/** Where a launch trades at the block read. */
export type Venue = "curve" | "pool" | "between" | "unknown";

export const VENUES: readonly Venue[] = ["curve", "pool", "between", "unknown"];

export type VenueCounts = Record<Venue, number>;

export interface PulsePair {
  /** The pair asset's address, lowercased. */
  key: string;
  /** Null when the asset's decimals and symbol could not be read; its address is shown instead. */
  pair: Asset | null;
  address: string;
  launches: number;
  /** Null until every launch's curve is read. */
  venues: VenueCounts | null;
}

export interface PulseRate {
  bps: number;
  launches: number;
}

export interface TwinGroup {
  /** The symbol or name as the newest launch of the group states it. */
  label: string;
  /** Newest first. */
  launches: Launch[];
}

export interface PulseDetail {
  venues: VenueCounts;
  /** Creator tax rates, lowest first: the most common rates, at most `maxRates`. */
  rates: PulseRate[];
  /** The rates left out of `rates`: how many distinct rates and how many launches use them. */
  otherRates: { rates: number; launches: number };
  /** Launches whose rate could not be read. */
  rateUnknown: number;
  /** Launches with a creator tax above zero. */
  taxed: number;
  /** Launches with a rate read, for the shares. */
  rateKnown: number;
  /** Launches that share their symbol with another launch of these hours, in groups, largest first. */
  sameSymbol: TwinGroup[];
  /** The same for names. */
  sameName: TwinGroup[];
  /** Launches in at least one group. */
  twinned: number;
}

export interface Pulse {
  fromBlock: bigint;
  toBlock: bigint;
  launches: number;
  /** Pair assets, most launches first, at most `maxPairs`. */
  pairs: PulsePair[];
  /** Pair assets left out of `pairs`. */
  otherPairs: { pairs: number; launches: number };
  /** Distinct pair assets. */
  pairCount: number;
  /** Curves whose pool the factory created in these blocks (`PoolGraduated`). */
  graduated: number;
  /** Of those, the ones launched in these blocks too. */
  graduatedHere: number;
  /** Null while some launches' curves are still being read. */
  detail: PulseDetail | null;
}

export interface PulseInput {
  fromBlock: bigint;
  toBlock: bigint;
  /** Launches whose curves were read. */
  launches: readonly Launch[];
  /** Launch events whose curves are not read yet: counted by pair asset, not in the detail. */
  pending?: readonly LaunchEvent[];
  graduations: readonly GraduationEvent[];
  /** Pair assets read so far, by lowercased address, to name the pending launches' pairs. */
  assets?: ReadonlyMap<string, Asset>;
  maxPairs?: number;
  maxRates?: number;
  maxGroups?: number;
}

const lower = (value: string) => value.toLowerCase();

/** The key two symbols or names share: case, spaces and leading dollar signs aside. */
export function twinKey(text: string | null): string | null {
  if (!text) return null;
  const key = text.normalize("NFKC").replace(/^\$+/, "").replace(/\s+/g, "").toLowerCase();
  return key.length > 0 ? key : null;
}

function emptyVenues(): VenueCounts {
  return { curve: 0, pool: 0, between: 0, unknown: 0 };
}

/** Where one launch trades, from its curve's `graduated()` and the pools created in these blocks. */
export function venueOf(launch: Launch, pooled: ReadonlySet<string>): Venue {
  if (pooled.has(lower(launch.token))) return "pool";
  if (launch.graduated === false) return "curve";
  if (launch.graduated === true) return "between";
  return "unknown";
}

function inRange(block: bigint | null, from: bigint, to: bigint): boolean {
  return block === null || (block >= from && block <= to);
}

function groups(
  launches: readonly Launch[],
  pick: (launch: Launch) => string | null,
  max: number,
  limit: number,
): { shown: TwinGroup[]; members: Set<string> } {
  const byKey = new Map<string, Launch[]>();
  for (const launch of launches) {
    // Text cut short to fit (cleanText) may go on differently on the chain, so it is no ground to call two alike.
    const text = pick(launch);
    const key = wasCut(text, max) ? null : twinKey(text);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(launch);
    else byKey.set(key, [launch]);
  }
  const all = [...byKey.values()]
    .filter((list) => list.length > 1)
    .map((list) => list.slice().sort(newestFirst))
    .sort((a, b) => b.length - a.length || newestFirst(a[0]!, b[0]!));
  const members = new Set(all.flat().map((launch) => lower(launch.token)));
  return { shown: all.slice(0, limit).map((list) => ({ label: pick(list[0]!) ?? "", launches: list })), members };
}

function newestFirst(a: Launch, b: Launch): number {
  const x = a.block ?? 0n;
  const y = b.block ?? 0n;
  if (x !== y) return x > y ? -1 : 1;
  return (b.launchedAt ?? 0) - (a.launchedAt ?? 0) || (lower(a.token) < lower(b.token) ? -1 : 1);
}

/** The pulse of [fromBlock, toBlock]. Launches and events outside it are left out; a token counts once. */
export function computePulse(input: PulseInput): Pulse {
  const { fromBlock, toBlock } = input;
  const maxPairs = input.maxPairs ?? 6;
  const maxRates = input.maxRates ?? 7;
  const maxGroups = input.maxGroups ?? 6;

  const seen = new Set<string>();
  const launches = input.launches.filter((launch) => {
    const key = lower(launch.token);
    if (seen.has(key) || !inRange(launch.block, fromBlock, toBlock)) return false;
    seen.add(key);
    return true;
  });
  const pending = (input.pending ?? []).filter((event) => {
    const key = lower(event.token);
    if (seen.has(key) || !inRange(event.block, fromBlock, toBlock)) return false;
    seen.add(key);
    return true;
  });
  const pooled = new Set(input.graduations.filter((event) => inRange(event.block, fromBlock, toBlock)).map((event) => lower(event.token)));
  const complete = pending.length === 0;

  // Pair assets, from read launches and pending events alike.
  const byPair = new Map<string, { pair: Asset | null; address: string; launches: number; venues: VenueCounts }>();
  const row = (address: string, pair: Asset | null) => {
    const key = lower(address);
    let entry = byPair.get(key);
    if (!entry) {
      entry = { pair, address, launches: 0, venues: emptyVenues() };
      byPair.set(key, entry);
    }
    if (!entry.pair && pair) entry.pair = pair;
    return entry;
  };
  const venues = emptyVenues();
  for (const launch of launches) {
    const entry = row(launch.pair.address, launch.pair);
    entry.launches += 1;
    const venue = venueOf(launch, pooled);
    entry.venues[venue] += 1;
    venues[venue] += 1;
  }
  for (const event of pending) {
    const key = lower(event.pairToken);
    const pair = key === lower(NATIVE) ? ETH : (input.assets?.get(key) ?? null);
    row(event.pairToken, pair).launches += 1;
  }
  const orderedPairs = [...byPair.entries()].sort((a, b) => b[1].launches - a[1].launches || (a[0] < b[0] ? -1 : 1));
  const pairs: PulsePair[] = orderedPairs.slice(0, maxPairs).map(([key, entry]) => ({
    key,
    pair: entry.pair,
    address: entry.address,
    launches: entry.launches,
    venues: complete ? entry.venues : null,
  }));
  const folded = orderedPairs.slice(maxPairs);

  let detail: PulseDetail | null = null;
  if (complete) {
    const counts = new Map<number, number>();
    let rateUnknown = 0;
    for (const launch of launches) {
      if (launch.creatorTaxBps === null) rateUnknown += 1;
      else counts.set(launch.creatorTaxBps, (counts.get(launch.creatorTaxBps) ?? 0) + 1);
    }
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const kept = common.slice(0, maxRates);
    const rest = common.slice(maxRates);
    const symbols = groups(launches, (launch) => launch.symbol, SYMBOL_MAX, maxGroups);
    const names = groups(launches, (launch) => launch.name, NAME_MAX, maxGroups);
    detail = {
      venues,
      rates: kept.map(([bps, n]) => ({ bps, launches: n })).sort((a, b) => a.bps - b.bps),
      otherRates: { rates: rest.length, launches: rest.reduce((sum, [, n]) => sum + n, 0) },
      rateUnknown,
      taxed: [...counts.entries()].reduce((sum, [bps, n]) => sum + (bps > 0 ? n : 0), 0),
      rateKnown: launches.length - rateUnknown,
      sameSymbol: symbols.shown,
      sameName: names.shown,
      twinned: new Set([...symbols.members, ...names.members]).size,
    };
  }

  const launchedHere = new Set([...launches.map((launch) => lower(launch.token)), ...pending.map((event) => lower(event.token))]);
  return {
    fromBlock,
    toBlock,
    launches: launches.length + pending.length,
    pairs,
    otherPairs: { pairs: folded.length, launches: folded.reduce((sum, [, entry]) => sum + entry.launches, 0) },
    pairCount: byPair.size,
    graduated: pooled.size,
    graduatedHere: [...pooled].filter((token) => launchedHere.has(token)).length,
    detail,
  };
}
