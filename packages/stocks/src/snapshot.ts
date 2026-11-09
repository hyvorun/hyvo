/**
 * Hyvo's list of stock tokens, made by `pnpm --filter @hyvo/stocks scan` (scripts/scan.ts) from the
 * chain alone: every token the StockFactory deployed, found through the factory's nonce and its
 * `Deployed` events, and every multiplier and name change each token recorded since. The pages read
 * each token live as well; this list is what lets a ticker be looked up, and what holds the history
 * that the free RPC cannot search on demand.
 */
import type { Address, Hex } from "viem";
// The attribute lets plain Node (a CLI, the Playwright tests) load the list as well as bundlers.
import data from "./snapshot.json" with { type: "json" };

/** One `UIMultiplierUpdated` event. Multipliers are raw uint256 values with 18 decimals. */
export interface MultiplierUpdate {
  block: number;
  /** The time of the block the update was sent in (ISO 8601). */
  time: string;
  tx: Hex;
  oldMultiplier: string;
  newMultiplier: string;
  /** When the new multiplier takes effect, in Unix seconds. */
  effectiveAt: number;
}

/** One `MetaDataUpdated` event: the token's name and ticker after it. */
export interface MetadataUpdate {
  block: number;
  time: string;
  tx: Hex;
  name: string;
  symbol: string;
}

export interface SnapshotToken {
  address: Address;
  uid: Hex;
  /** The ticker and name at the scan's block. */
  symbol: string;
  name: string;
  /** The factory's `Deployed` event. */
  deployed: { block: number; time: string; tx: Hex; name: string; symbol: string };
  multiplierUpdates: MultiplierUpdate[];
  metadataUpdates: MetadataUpdate[];
}

export interface Snapshot {
  version: 1;
  chainId: number;
  factory: Address;
  /** The block the scan read up to, and its time. */
  block: number;
  time: string;
  /** The factory's nonce at that block: one for the factory itself, plus one per deployed token. */
  factoryNonce: number;
  tokens: SnapshotToken[];
}

export const SNAPSHOT = data as unknown as Snapshot;

/** Tokens in the list whose ticker at the scan's block is `ticker` (case-insensitive). */
export function snapshotByTicker(ticker: string, snapshot: Snapshot = SNAPSHOT): SnapshotToken[] {
  const wanted = ticker.trim().toUpperCase();
  return snapshot.tokens.filter((token) => token.symbol.toUpperCase() === wanted);
}

export function snapshotByAddress(address: string, snapshot: Snapshot = SNAPSHOT): SnapshotToken | null {
  const wanted = address.toLowerCase();
  return snapshot.tokens.find((token) => token.address.toLowerCase() === wanted) ?? null;
}

/** Tokens whose ticker or name contains `text`, tickers that start with it first. */
export function searchSnapshot(text: string, snapshot: Snapshot = SNAPSHOT): SnapshotToken[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return snapshot.tokens;
  const hits = snapshot.tokens.filter(
    (token) => token.symbol.toLowerCase().includes(needle) || token.name.toLowerCase().includes(needle) || token.address.toLowerCase() === needle,
  );
  const rank = (token: SnapshotToken) => {
    const symbol = token.symbol.toLowerCase();
    return symbol === needle ? 0 : symbol.startsWith(needle) ? 1 : symbol.includes(needle) ? 2 : 3;
  };
  return hits.sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
}
