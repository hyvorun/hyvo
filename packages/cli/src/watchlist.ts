// The watchlist: token addresses the user chose to follow, kept in one local file. `hyvo watch` re-checks them.
// Public addresses only; the file is never uploaded anywhere.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress, toChecksumAddress } from "@hyvo/check";
import { oneLine } from "./format/text.js";

export interface Watchlist {
  /** Checksummed, in the order they were added, no repeats. */
  tokens: string[];
  /** Address to the user's own name for it. */
  labels: Record<string, string>;
}

export const EMPTY_WATCHLIST: Watchlist = { tokens: [], labels: {} };

export function watchlistPath(dir: string): string {
  return join(dir, "watchlist.json");
}

/** A watchlist from untrusted JSON: anything that is not an address is dropped, not fatal. */
export function parseWatchlist(raw: unknown): Watchlist {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tokens: string[] = [];
  if (Array.isArray(obj.tokens)) {
    for (const value of obj.tokens) {
      if (typeof value !== "string" || !isAddress(value)) continue;
      const address = toChecksumAddress(value);
      if (!tokens.includes(address)) tokens.push(address);
    }
  }
  const labels: Record<string, string> = {};
  if (obj.labels && typeof obj.labels === "object") {
    for (const [key, value] of Object.entries(obj.labels as Record<string, unknown>)) {
      if (!isAddress(key) || typeof value !== "string") continue;
      const address = toChecksumAddress(key);
      if (tokens.includes(address)) labels[address] = cleanLabel(value);
    }
  }
  return { tokens, labels };
}

export function cleanLabel(label: string): string {
  return oneLine(label, 40);
}

export function loadWatchlist(dir: string): Watchlist {
  try {
    return parseWatchlist(JSON.parse(readFileSync(watchlistPath(dir), "utf8")));
  } catch {
    return { tokens: [], labels: {} };
  }
}

export function saveWatchlist(dir: string, watchlist: Watchlist): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(watchlistPath(dir), `${JSON.stringify(watchlist, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function addToken(list: Watchlist, address: string, label?: string): { next: Watchlist; already: boolean } {
  const token = toChecksumAddress(address);
  const already = list.tokens.includes(token);
  const next: Watchlist = { tokens: already ? [...list.tokens] : [...list.tokens, token], labels: { ...list.labels } };
  if (label !== undefined) {
    const clean = cleanLabel(label);
    if (clean) next.labels[token] = clean;
  }
  return { next, already };
}

export function removeToken(list: Watchlist, address: string): { next: Watchlist; removed: boolean } {
  const token = toChecksumAddress(address);
  const labels = { ...list.labels };
  delete labels[token];
  return { next: { tokens: list.tokens.filter((t) => t !== token), labels }, removed: list.tokens.includes(token) };
}
