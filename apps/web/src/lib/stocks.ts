/**
 * The stock pages' reads: @hyvo/stocks over the browser's own RPC client (lib/chain), and
 * Chainlink's feed directory fetched once per ten minutes. Nothing goes through Hyvo's API.
 */
import { fetchFeedDirectory, STOCK_FACTORY, stockReport, type FeedListing, type StockReport } from "@hyvo/stocks";
import type { Address } from "viem";
import { publicClient } from "./chain";

const DIRECTORY_TTL_MS = 10 * 60_000;
let directory: { at: number; value: Promise<{ listings: FeedListing[]; fetchedAt: string }> } | null = null;

/** Chainlink's directory, shared by every page view for ten minutes; a failure is not kept. */
function cachedDirectory(): Promise<{ listings: FeedListing[]; fetchedAt: string }> {
  if (directory && Date.now() - directory.at < DIRECTORY_TTL_MS) return directory.value;
  const value = fetchFeedDirectory();
  directory = { at: Date.now(), value };
  value.catch(() => {
    if (directory?.value === value) directory = null;
  });
  return value;
}

export function loadStockReport(address: Address): Promise<StockReport> {
  return stockReport(publicClient(), address, { directory: cachedDirectory });
}

/** The factory's nonce (one plus the tokens it deployed) and the block it was read at. */
export async function loadFactoryCount(): Promise<{ nonce: number; block: bigint }> {
  const client = publicClient();
  const block = await client.getBlockNumber();
  const nonce = await client.getTransactionCount({ address: STOCK_FACTORY, blockNumber: block });
  return { nonce, block };
}
