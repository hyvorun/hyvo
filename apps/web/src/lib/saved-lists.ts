/**
 * The watchlist and the followed wallets as this browser keeps them, for everyone (HYVO holders also keep them with
 * their account: lib/use-saved-list.ts). Storage can be blocked, full or cleared: every access is guarded, and a page
 * works the same without it, for the length of the visit.
 */
import { TRACKED_MAX_FREE, TRACKED_MAX_HOLDER, WATCHLIST_MAX } from "@hyvo/schema";
import type { HolderState } from "./holder-status";

export type ListKind = "watchlist" | "tracked";

export const LIST_KEYS: Record<ListKind, string> = { watchlist: "hyvo.watchlist", tracked: "hyvo.tracked" };

/** What a list keeps at most in the browser: the account's limits, so nothing is lost when a holder syncs. */
export const LIST_MAX: Record<ListKind, number> = { watchlist: WATCHLIST_MAX, tracked: TRACKED_MAX_HOLDER };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null where it is blocked. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** An address typed or pasted by a person, trimmed, or null when it is not one. */
export function parseAddress(input: string): `0x${string}` | null {
  const text = input.trim();
  return ADDRESS.test(text) ? (text.toLowerCase() as `0x${string}`) : null;
}

/** Addresses only, each once (in lowercase), in the order first seen, at most `max`. */
export function cleanList(items: readonly unknown[], max: number): `0x${string}`[] {
  const out: `0x${string}`[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string" || !ADDRESS.test(item)) continue;
    const address = item.toLowerCase() as `0x${string}`;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
    if (out.length >= max) break;
  }
  return out;
}

/** The list stored under `kind`; empty when nothing is stored, the value is unreadable or storage is blocked. */
export function loadList(storage: StorageLike | null, kind: ListKind): `0x${string}`[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LIST_KEYS[kind]) ?? "[]");
    return Array.isArray(parsed) ? cleanList(parsed, LIST_MAX[kind]) : [];
  } catch {
    return [];
  }
}

/** Store the list; false when storage refused it. */
export function saveList(storage: StorageLike | null, kind: ListKind, list: readonly string[]): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LIST_KEYS[kind], JSON.stringify(cleanList(list, LIST_MAX[kind])));
    return true;
  } catch {
    return false;
  }
}

export type AddResult = "added" | "already" | "full" | "invalid";

/** The list with `address` added at the end, and what happened. */
export function addTo(list: readonly `0x${string}`[], address: string, max: number): { list: `0x${string}`[]; result: AddResult } {
  const parsed = parseAddress(address);
  if (!parsed) return { list: [...list], result: "invalid" };
  if (list.includes(parsed)) return { list: [...list], result: "already" };
  if (list.length >= max) return { list: [...list], result: "full" };
  return { list: [...list, parsed], result: "added" };
}

export function removeFrom(list: readonly `0x${string}`[], address: string): `0x${string}`[] {
  const target = address.toLowerCase();
  return list.filter((item) => item !== target);
}

/** The account's list first, then what only this browser has, each once, at most `max`. */
export function mergeLists(account: readonly string[], local: readonly string[], max: number): `0x${string}`[] {
  return cleanList([...account, ...local], max);
}

/**
 * A holder's list once this browser has read the account's: the account's list less what this browser took off since
 * the two last agreed (`base`), then what this browser added since then, at most `max`. So a launch taken off in one
 * browser stays off in the others. Without a `base` (this browser has not met the account yet) nothing counts as taken
 * off here, and the two lists are joined, the account's first.
 */
export function mergeWithBase(account: readonly string[], local: readonly string[], base: readonly string[] | null, max: number): `0x${string}`[] {
  const here = new Set(local.map((item) => item.toLowerCase()));
  const agreed = new Set((base ?? []).map((item) => item.toLowerCase()));
  const takenOffHere = (item: string) => agreed.has(item.toLowerCase()) && !here.has(item.toLowerCase());
  const addedHere = local.filter((item) => !agreed.has(item.toLowerCase()));
  return cleanList([...account.filter((item) => !takenOffHere(item)), ...addedHere], max);
}

const baseKey = (kind: ListKind) => `${LIST_KEYS[kind]}.synced`;

/** The list this browser and `wallet`'s account last agreed on; null when they have not, for another wallet, or without storage. */
export function loadBase(storage: StorageLike | null, kind: ListKind, wallet: string): `0x${string}`[] | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(baseKey(kind)) ?? "null") as { wallet?: unknown; list?: unknown } | null;
    if (!parsed || typeof parsed.wallet !== "string" || parsed.wallet !== wallet.toLowerCase() || !Array.isArray(parsed.list)) return null;
    return cleanList(parsed.list, LIST_MAX[kind]);
  } catch {
    return null;
  }
}

/** Remember the list this browser and `wallet`'s account now agree on. */
export function saveBase(storage: StorageLike | null, kind: ListKind, wallet: string, list: readonly string[]): void {
  if (!storage) return;
  try {
    storage.setItem(baseKey(kind), JSON.stringify({ wallet: wallet.toLowerCase(), list: cleanList(list, LIST_MAX[kind]) }));
  } catch {
    // Storage full or blocked: the next visit joins the lists instead.
  }
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item.toLowerCase() === b[i]?.toLowerCase());
}

/** Wallets one can follow on /track: 25 for holders, 1 for everyone else. */
export function trackLimit(status: HolderState): number {
  return status === "holder" ? TRACKED_MAX_HOLDER : TRACKED_MAX_FREE;
}
