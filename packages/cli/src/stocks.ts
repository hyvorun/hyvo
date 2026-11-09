// `hyvo stocks` and the MCP tool stock_token: Robinhood's stock tokens, with @hyvo/stocks, the reads the web pages
// use. The list is Hyvo's scan of the chain that ships with @hyvo/stocks; one token is read live at one block:
// the factory's record, the multiplier, the pause flags and its Chainlink feed. Nothing is signed or sent.

import { CALL_ENDPOINTS } from "@hyvo/launches";
import {
  fetchFeedDirectory,
  parseQuery,
  searchSnapshot,
  shortName,
  SNAPSHOT,
  snapshotByTicker,
  STOCK_FACTORY,
  stockReport,
  usEquitySession,
  type SessionNow,
  type SnapshotToken,
  type StockReport,
} from "@hyvo/stocks";
import { createPublicClient, fallback, http, type Address, type PublicClient } from "viem";
import type { Resolved } from "./config.js";
import { checkDisclaimer } from "./format/check.js";
import { toJson } from "./requests.js";

export const CHAIN_ID = 4663;
const TIMEOUT_MS = 12_000;

/**
 * A viem client over Robinhood Chain's public endpoints, tried in order, or over the one RPC the user chose.
 * CCIP-Read is off: a contract's revert could otherwise name a URL for the client to fetch.
 */
export function stocksClient(rpc: Resolved, fetchFn: typeof fetch): PublicClient {
  const urls = rpc.from === "default" ? [...CALL_ENDPOINTS] : [rpc.url];
  const transports = urls.map((url) => http(url, { fetchFn, timeout: TIMEOUT_MS, retryCount: 1 }));
  return createPublicClient({ transport: transports.length === 1 ? transports[0]! : fallback(transports), ccipRead: false }) as PublicClient;
}

export interface StockList {
  /** The tokens shown: every one, or those matching the search. */
  tokens: SnapshotToken[];
  search: string | null;
  /** The factory's nonce read live, or why it could not be. */
  live: { block: bigint; nonce: number; since: number } | { error: string };
}

/** Hyvo's list, and whether the factory has deployed anything since it was made. */
export async function stockList(client: PublicClient, search: string | null): Promise<StockList> {
  const tokens = search ? searchSnapshot(search) : [...SNAPSHOT.tokens].sort((a, b) => a.symbol.localeCompare(b.symbol));
  let live: StockList["live"];
  try {
    const block = await client.getBlockNumber();
    const nonce = await client.getTransactionCount({ address: STOCK_FACTORY, blockNumber: block });
    live = { block, nonce, since: nonce - SNAPSHOT.factoryNonce };
  } catch (error) {
    live = { error: error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error) };
  }
  return { tokens, search, live };
}

export type StockTarget =
  | { kind: "address"; address: Address; ticker: null }
  | { kind: "ticker"; address: Address; ticker: string }
  | { kind: "unknown-ticker"; ticker: string; suggestions: SnapshotToken[] }
  | { kind: "several"; ticker: string; tokens: SnapshotToken[] }
  | { kind: "invalid"; reason: string };

/** What a ticker or an address names, from Hyvo's list, before anything is read. */
export function stockTarget(text: string): StockTarget {
  const query = parseQuery(text);
  if (query.kind === "empty") return { kind: "invalid", reason: "give a ticker, such as NVDA, or a contract address" };
  if (query.kind === "invalid") return { kind: "invalid", reason: query.reason };
  if (query.kind === "address") return { kind: "address", address: query.address, ticker: null };
  const matches = snapshotByTicker(query.ticker);
  if (matches.length === 1) return { kind: "ticker", address: matches[0]!.address, ticker: query.ticker };
  if (matches.length > 1) return { kind: "several", ticker: query.ticker, tokens: matches };
  return { kind: "unknown-ticker", ticker: query.ticker, suggestions: searchSnapshot(text.trim()).slice(0, 5) };
}

export interface StockFacts {
  report: StockReport;
  ticker: string | null;
  /** The US equity session at the block's time, by Chainlink's session table. */
  session: SessionNow;
}

/** One contract read as a stock token, with its Chainlink feed found through Chainlink's directory. */
export async function stockFacts(client: PublicClient, target: { address: Address; ticker: string | null }, fetchFn: typeof fetch): Promise<StockFacts> {
  const report = await stockReport(client, target.address, { directory: () => fetchFeedDirectory(fetchFn) });
  return { report, ticker: target.ticker, session: usEquitySession(new Date(report.reading.blockTime * 1000)) };
}

/** The message for a ticker that names no single token, with what the list holds instead. */
export function targetProblem(target: Extract<StockTarget, { kind: "unknown-ticker" | "several" }>): string {
  if (target.kind === "several") {
    return `${target.tokens.length} tokens in Hyvo's list use the ticker ${target.ticker}: ${target.tokens.map((token) => token.address).join(", ")}. Look one up by its address.`;
  }
  const near = target.suggestions.map((token) => `${token.symbol} (${shortName(token.name)})`);
  return `no stock token in Hyvo's list has the ticker ${target.ticker}. The list holds every token the StockFactory deployed up to block ${SNAPSHOT.block}; one deployed since can be looked up by its address.${near.length > 0 ? ` Tickers or names that contain it: ${near.join(", ")}.` : ""}`;
}

// --- JSON ---------------------------------------------------------------------------------------------------

/** `hyvo stocks --json`. */
export function stockListJson(list: StockList) {
  return {
    chainId: CHAIN_ID,
    factory: SNAPSHOT.factory,
    snapshot: { block: SNAPSHOT.block, time: SNAPSHOT.time, factoryNonce: SNAPSHOT.factoryNonce, tokens: SNAPSHOT.tokens.length },
    live: "error" in list.live ? { error: list.live.error } : { block: list.live.block.toString(), factoryNonce: list.live.nonce, deployedSince: list.live.since },
    search: list.search,
    tokens: list.tokens.map((token) => ({
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      uid: token.uid,
      deployed: { block: token.deployed.block, time: token.deployed.time, tx: token.deployed.tx },
      multiplierChanges: token.multiplierUpdates.length,
    })),
    disclaimer: checkDisclaimer(BigInt(SNAPSHOT.block)),
  };
}

/** `hyvo stocks <ticker|address> --json` and the MCP tool stock_token: the report as read, bigints as strings. */
export function stockFactsJson(facts: StockFacts) {
  const { report } = facts;
  return {
    chainId: CHAIN_ID,
    ticker: facts.ticker,
    address: report.reading.address,
    block: report.reading.blockNumber.toString(),
    blockTime: report.reading.blockTime,
    verdict: report.verdict,
    reading: toJson(report.reading),
    system: report.system,
    multiplier: toJson(report.multiplier),
    movement: report.movement,
    session: facts.session,
    feed: toJson(report.feed),
    directoryFetchedAt: report.directoryFetchedAt,
    listed: report.listed,
    snapshot: report.snapshot,
    disclaimer: checkDisclaimer(report.reading.blockNumber),
  };
}
