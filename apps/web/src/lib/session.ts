/**
 * The signed-in session as this browser keeps it (lib/wallet.ts writes it after Sign-In with Ethereum), read without the
 * wallet libraries, so a page can know who is signed in without loading them.
 */
import type { Address } from "viem";

export const SESSION_KEY = "hyvo.session";

/** Sent on the window when this tab signs in or out (lib/wallet.ts). */
export const SESSION_EVENT = "hyvo:session";

export interface StoredSession {
  token: string;
  address: Address;
  expiresAt: string;
  admin: boolean;
}

/** The stored session when it is well formed and has more than a minute left; null otherwise, or when storage is blocked. */
export function readStoredSession(now = Date.now()): StoredSession | null {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Partial<StoredSession> | null;
    if (!stored || typeof stored.token !== "string" || typeof stored.address !== "string" || typeof stored.expiresAt !== "string") return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(stored.address)) return null;
    if (!(Date.parse(stored.expiresAt) > now + 60_000)) return null;
    return { token: stored.token, address: stored.address as Address, expiresAt: stored.expiresAt, admin: stored.admin === true };
  } catch {
    return null;
  }
}
