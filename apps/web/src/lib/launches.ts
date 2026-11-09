/**
 * Hyvo Launches in the browser: the visitor's own browser reads Pons launches from Robinhood Chain's
 * public endpoints (packages/launches), with no Hyvo server in between and nothing stored. The tests
 * point the reader at a stub with VITE_RPC_URLS, like the rest of the app.
 */
import { publicReader, type Asset, type ChainReader } from "@hyvo/launches";

const TEST_URLS = ((import.meta.env.VITE_RPC_URLS as string | undefined) ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

export function launchesReader(): ChainReader {
  return publicReader({ urls: TEST_URLS });
}

/** Pair assets do not change: their symbol and decimals are read once per visit. */
export const assetCache = new Map<string, Asset>();

/** The windows a visitor can pick, in hours. */
export const WINDOWS = [
  { id: "1h", hours: 1, label: "1 hour" },
  { id: "6h", hours: 6, label: "6 hours" },
  { id: "24h", hours: 24, label: "24 hours" },
] as const;

export type WindowId = (typeof WINDOWS)[number]["id"];

export function windowFrom(value: string | null): (typeof WINDOWS)[number] {
  return WINDOWS.find((item) => item.id === value) ?? WINDOWS[1];
}

/** The minutes "most traded" looks back over. */
export const RECENT_MINUTES = 15;

/** The hours Chain Pulse counts, whatever window the visitor picked. */
export const PULSE_HOURS = 24;

/** A Robinhood Chain address in a link, or null. */
export function tokenFromPath(value: string | undefined): `0x${string}` | null {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as `0x${string}`) : null;
}
