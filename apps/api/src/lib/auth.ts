/**
 * Sign-In with Ethereum (EIP-4361). Signing in is a signature, never a transaction. A verified
 * message gives a session token (sent back as `Authorization: Bearer <token>`); only its SHA-256
 * is stored. Nonces are single use and expire after 10 minutes.
 */
import type { MiddlewareHandler } from "hono";
import { getAddress, hashMessage, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { AppEnv } from "../env";
import { chainFor } from "./chain";
import { iso, nowS } from "./clock";
import { config, type Config } from "./config";
import { ApiError } from "./errors";
import { newNonce, newToken, sha256Hex } from "./ids";
import { rateLimit } from "./ratelimit";
import { recoverAddress } from "./secp256k1";

export const API_KEY_PREFIX = "hyvo_";
const KEY_REQUESTS_PER_MINUTE = 120;
/** `last_used_at` is written at most this often: a write per request would spend the free plan's allowance. */
const KEY_USED_EVERY_S = 3600;
export const NONCE_TTL_S = 600;
export const SESSION_TTL_S = 7 * 86_400;
/** How far in the future a message's `issuedAt` may be (clock skew). */
const ISSUED_AT_SKEW_S = 300;

export async function issueNonce(db: D1Database, now: number): Promise<{ nonce: string; expiresAt: string }> {
  const nonce = newNonce();
  await db.prepare("INSERT INTO siwe_nonces (nonce, expires_at) VALUES (?, ?)").bind(nonce, now + NONCE_TTL_S).run();
  return { nonce, expiresAt: iso(now + NONCE_TTL_S) };
}

export async function verifySiwe(
  db: D1Database,
  cfg: Config,
  message: string,
  signature: Hex,
  now: number,
): Promise<{ token: string; address: string; expiresAt: string; admin: boolean }> {
  const fields = parseSiweMessage(message);
  const refuse = (why: string) => new ApiError(401, "invalid_signature", `sign-in refused: ${why}`);
  if (!fields.address || !fields.nonce || !fields.domain || !fields.uri) throw refuse("the message is incomplete");
  if (fields.version !== "1") throw refuse("unsupported message version");
  if (fields.chainId !== cfg.chainId) throw refuse(`sign in on chain ${cfg.chainId}`);
  if (
    !validateSiweMessage({ message: fields, domain: cfg.siweDomain, time: new Date(now * 1000) }) ||
    !cfg.siweDomain
  ) {
    throw refuse("wrong domain, or the message has expired");
  }
  if (cfg.webOrigin && safeOrigin(fields.uri) !== cfg.webOrigin) throw refuse("wrong URI");
  if (fields.issuedAt && fields.issuedAt.getTime() / 1000 > now + ISSUED_AT_SKEW_S) {
    throw refuse("issued in the future");
  }

  const address = getAddress(fields.address);
  let valid = recoverAddress(hashMessage(message), signature)?.toLowerCase() === address.toLowerCase();
  if (!valid && cfg.rpcUrls.length > 0) {
    // A smart wallet (ERC-1271 / ERC-6492) signs differently; ask the chain.
    try {
      valid = await chainFor(cfg).verifyMessage(address, message, signature);
    } catch {
      valid = false;
    }
  }
  if (!valid) throw refuse("the signature does not match the address");

  // The nonce is used up only by a valid signature, and only once.
  const used = await db
    .prepare("DELETE FROM siwe_nonces WHERE nonce = ? AND expires_at > ? RETURNING nonce")
    .bind(fields.nonce, now)
    .first();
  if (!used) throw refuse("unknown or expired nonce; ask for a new one");

  const token = newToken();
  await db
    .prepare("INSERT INTO sessions (token_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), address.toLowerCase(), now, now + SESSION_TTL_S)
    .run();
  return { token, address, expiresAt: iso(now + SESSION_TTL_S), admin: cfg.admins.has(address.toLowerCase()) };
}

export async function endSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

export function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

/** Requires a session; sets `address` (checksummed). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token) throw new ApiError(401, "unauthorized", "sign in first");
  const row = await c.env.DB.prepare("SELECT address FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(token), nowS())
    .first<{ address: string }>();
  if (!row) throw new ApiError(401, "unauthorized", "the session has expired; sign in again");
  c.set("address", getAddress(row.address));
  await next();
};

/** The wallet of an API key, or null for an unknown or revoked key. */
export async function keyAccount(db: D1Database, key: string, now: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT id, address, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(key))
    .first<{ id: string; address: string; last_used_at: number | null }>();
  if (!row) return null;
  await rateLimit(db, "key", row.id, KEY_REQUESTS_PER_MINUTE, 60, now);
  if (row.last_used_at === null || row.last_used_at + KEY_USED_EVERY_S <= now) {
    await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return getAddress(row.address);
}

/** Requires a session or an API key; sets `address` (checksummed). */
export const requireAccount: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token.startsWith(API_KEY_PREFIX)) return requireSession(c, next);
  const address = await keyAccount(c.env.DB, token, nowS());
  if (!address) throw new ApiError(401, "unauthorized", "this API key is not valid");
  c.set("address", address);
  await next();
};

/** Requires a session of a founder wallet (ADMIN_ADDRESSES). */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  await requireSession(c, async () => {
    if (!config(c.env).admins.has(c.get("address").toLowerCase())) {
      throw new ApiError(403, "forbidden", "this wallet is not an admin");
    }
    await next();
  });
};

function safeOrigin(uri: string): string | null {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}
