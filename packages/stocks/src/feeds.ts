/**
 * Chainlink's reference data directory for Robinhood Chain: where Chainlink lists each feed's proxy
 * address, decimals, heartbeat and deviation threshold (it is the data behind the feed tables on
 * docs.chain.link). Hyvo keeps only the feeds Chainlink labels as a tokenized equity's primary
 * price ("primaryTokenizedPrice"), because those are the ones Chainlink's Robinhood page describes:
 * the price of one token, the underlying's price times the token's uiMultiplier().
 */
import { getAddress, type Address } from "viem";

export const FEED_DIRECTORY_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

export interface FeedListing {
  /** The ticker in the feed's name: "Robinhood NVDA / USD" is NVDA. */
  ticker: string;
  name: string;
  assetName: string | null;
  proxy: Address;
  decimals: number;
  heartbeatSeconds: number;
  /** How far the price may move, in percent, before the feed updates. */
  deviationPercent: number | null;
  marketHours: string | null;
}

const NAME = /^Robinhood ([A-Z0-9.]+)(?: \/ USD|-USD)$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The Robinhood tokenized-equity feeds in the directory's JSON. Anything else is skipped. */
export function parseFeedDirectory(body: unknown): FeedListing[] {
  if (!Array.isArray(body)) throw new Error("Chainlink's feed directory did not answer with a list.");
  const out: FeedListing[] = [];
  for (const entry of body) {
    if (!isRecord(entry) || !isRecord(entry.docs)) continue;
    if (entry.docs.productTypeCode !== "primaryTokenizedPrice") continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    const ticker = NAME.exec(name)?.[1];
    const proxy = typeof entry.proxyAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(entry.proxyAddress) ? getAddress(entry.proxyAddress.toLowerCase()) : null;
    const decimals = entry.decimals;
    const heartbeat = entry.heartbeat;
    if (!ticker || !proxy || !Number.isInteger(decimals) || !Number.isInteger(heartbeat) || (heartbeat as number) <= 0) continue;
    out.push({
      ticker,
      name,
      assetName: typeof entry.assetName === "string" && entry.assetName ? entry.assetName : null,
      proxy,
      decimals: decimals as number,
      heartbeatSeconds: heartbeat as number,
      deviationPercent: typeof entry.threshold === "number" ? entry.threshold : null,
      marketHours: typeof entry.docs.marketHours === "string" ? entry.docs.marketHours : null,
    });
  }
  if (out.length === 0) throw new Error("Chainlink's feed directory lists no Robinhood tokenized equity feeds; its format may have changed.");
  return out;
}

export type FeedMatch = { kind: "one"; listing: FeedListing } | { kind: "none" } | { kind: "several"; listings: FeedListing[] };

/** The feed for a token's ticker. Two feeds for one ticker are reported, never chosen between. */
export function feedForTicker(listings: FeedListing[], ticker: string): FeedMatch {
  const matches = listings.filter((listing) => listing.ticker === ticker.toUpperCase());
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "several", listings: matches };
  return { kind: "one", listing: matches[0]! };
}

/** Fetch and parse the directory. `fetchImpl` lets the Worker or a test supply its own fetch. */
export async function fetchFeedDirectory(fetchImpl: typeof fetch = fetch): Promise<{ listings: FeedListing[]; fetchedAt: string }> {
  const response = await fetchImpl(FEED_DIRECTORY_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Chainlink's feed directory answered ${response.status}.`);
  const listings = parseFeedDirectory(await response.json());
  return { listings, fetchedAt: new Date().toISOString() };
}
