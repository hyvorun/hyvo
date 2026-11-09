/**
 * Everything Hyvo says about one contract, read in one go: the factory's record, the multiplier,
 * the Chainlink price, the pause flags and the history from Hyvo's scan. The web page renders it;
 * a CLI command or the Worker can return it as it is.
 */
import type { Address, PublicClient } from "viem";
import { feedForTicker, type FeedListing } from "./feeds";
import {
  movementFacts,
  multiplierFacts,
  priceFacts,
  systemFacts,
  verdictOf,
  type MovementFacts,
  type MultiplierFacts,
  type PriceFacts,
  type Verdict,
} from "./facts";
import { readFeed, readStock, type FeedReading, type StockReading } from "./read";
import { SNAPSHOT, snapshotByAddress, type Snapshot, type SnapshotToken } from "./snapshot";

export type FeedPart =
  | { kind: "read"; listing: FeedListing; reading: FeedReading; price: PriceFacts }
  | { kind: "none" }
  | { kind: "several"; listings: FeedListing[] }
  | { kind: "directory-failed"; message: string }
  | { kind: "read-failed"; listing: FeedListing; message: string };

export interface StockReport {
  reading: StockReading;
  verdict: Verdict;
  system: ReturnType<typeof systemFacts>;
  /** Hyvo's list entry for this address, with its history up to the scan's block. */
  listed: SnapshotToken | null;
  snapshot: { block: number; time: string };
  multiplier: MultiplierFacts | null;
  movement: MovementFacts | null;
  feed: FeedPart | null;
  /** When Chainlink's directory was fetched, for the page to say so. */
  directoryFetchedAt: string | null;
}

export interface ReportOptions {
  /** Chainlink's directory: fetchFeedDirectory, or a cached copy. Left out, no price is read. */
  directory?: () => Promise<{ listings: FeedListing[]; fetchedAt: string }>;
  snapshot?: Snapshot;
  /** The time "now" is, for the price's age (Unix seconds). Defaults to the clock. */
  now?: number;
}

export async function stockReport(client: PublicClient, address: Address, options: ReportOptions = {}): Promise<StockReport> {
  const snapshot = options.snapshot ?? SNAPSHOT;
  const directory = options.directory
    ? options.directory().then(
        (value) => ({ ok: true as const, ...value }),
        (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
      )
    : null;
  const reading = await readStock(client, address);
  const verdict = verdictOf(reading);
  const listed = snapshotByAddress(address, snapshot);
  const token = reading.token;
  const multiplier = token ? multiplierFacts(token, reading.blockTime, listed?.multiplierUpdates) : null;
  const movement = token ? movementFacts(reading, token) : null;

  let feed: FeedPart | null = null;
  let directoryFetchedAt: string | null = null;
  // A price only for a contract the factory records: anything else may only borrow a ticker.
  if (directory && token && multiplier && verdict.kind === "registered") {
    const answer = await directory;
    if (!answer.ok) feed = { kind: "directory-failed", message: answer.message };
    else {
      directoryFetchedAt = answer.fetchedAt;
      const match = feedForTicker(answer.listings, token.symbol);
      if (match.kind === "none") feed = { kind: "none" };
      else if (match.kind === "several") feed = { kind: "several", listings: match.listings };
      else {
        try {
          const feedReading = await readFeed(client, match.listing.proxy, reading.blockNumber);
          const now = options.now ?? Math.floor(Date.now() / 1000);
          feed = { kind: "read", listing: match.listing, reading: feedReading, price: priceFacts(match.listing, feedReading, token, multiplier, now) };
        } catch (error) {
          feed = { kind: "read-failed", listing: match.listing, message: error instanceof Error ? error.message : String(error) };
        }
      }
    }
  }

  return {
    reading,
    verdict,
    system: systemFacts(reading),
    listed,
    snapshot: { block: snapshot.block, time: snapshot.time },
    multiplier,
    movement,
    feed,
    directoryFetchedAt,
  };
}
