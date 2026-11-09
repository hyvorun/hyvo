/**
 * Holder benefits (SPEC 8.3, money rule 6): a wallet holding at least HOLDER_MIN Hyvo tokens both
 * now and at the block of 24 h ago gets FREE_RUNS_PER_MONTH small runs and a discount. Nothing is
 * paid out. When a balance cannot be read (RPC down, state too old), the wallet is not eligible.
 */
import type { HolderStatus } from "@hyvo/schema";
import { formatUnits, getAddress, type Address } from "viem";
import { chainFor } from "./chain";
import { utcMonth } from "./clock";
import type { Config } from "./config";

/** How long a wallet must already have held the minimum: it is read now and at the block of this long ago. */
export const HELD_FOR_S = 86_400;
/** How far the block found for "24 h ago" may be from it. */
const SNAPSHOT_TOLERANCE_S = 600;

export async function creditsUsed(db: D1Database, address: string, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT used FROM credit_usage WHERE address = ? AND month = ?")
    .bind(address.toLowerCase(), utcMonth(now))
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/** Use one free run of this month; false when none is left. */
export async function useCredit(db: D1Database, cfg: Config, address: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO credit_usage (address, month, used) VALUES (?, ?, 1)
       ON CONFLICT(address, month) DO UPDATE SET used = used + 1 WHERE used < ?
       RETURNING used`,
    )
    .bind(address.toLowerCase(), utcMonth(now), cfg.holder.freeRunsPerMonth)
    .first<{ used: number }>();
  return row !== null && row.used <= cfg.holder.freeRunsPerMonth;
}

export async function returnCredit(db: D1Database, address: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE credit_usage SET used = used - 1 WHERE address = ? AND month = ? AND used > 0")
    .bind(address.toLowerCase(), utcMonth(now))
    .run();
}

/** `GET /v1/health`'s `holder`: what a wallet must hold, and for how long, or null while holder benefits are off. */
export function holderRequirement(cfg: Config): { min: string; decimals: number; heldForSeconds: number } | null {
  if (!cfg.features.holder || !cfg.hyvoToken) return null;
  return { min: cfg.holder.minText, decimals: cfg.hyvoToken.decimals, heldForSeconds: HELD_FOR_S };
}

/** What holding the token changes about a paid run: its discount and its place in the queue. */
export async function holderTerms(
  db: D1Database,
  cfg: Config,
  address: string,
  now: number,
): Promise<{ discountBps: number; priority: number }> {
  if (!cfg.features.holder) return { discountBps: 0, priority: 0 };
  const holder = await holderStatus(db, cfg, address, now);
  return holder.eligible ? { discountBps: holder.discountBps, priority: 1 } : { discountBps: 0, priority: 0 };
}

export async function holderStatus(db: D1Database, cfg: Config, address: string, now: number): Promise<HolderStatus> {
  const base: HolderStatus = {
    enabled: cfg.features.holder,
    eligible: false,
    minBalance: cfg.holder.minText,
    balance: null,
    balance24hAgo: null,
    freeRunsPerMonth: cfg.holder.freeRunsPerMonth,
    freeRunsLeft: 0,
    discountBps: 0,
    freeRunMax: { agents: cfg.holder.freeRunMaxAgents, rounds: cfg.holder.freeRunMaxRounds },
  };
  const token = cfg.hyvoToken;
  if (!cfg.features.holder || !token) return base;
  const owner = getAddress(address);
  let now_: bigint | null = null;
  let then: bigint | null = null;
  try {
    const chain = chainFor(cfg);
    now_ = await chain.balanceOf(token.address, owner);
    const block = await blockAt(cfg, now - HELD_FOR_S);
    then = block === null ? null : await chain.balanceOf(token.address, owner, block);
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "holder_balance_failed", error: String(error).slice(0, 200) }));
  }
  const min = cfg.holder.min;
  const eligible = min > 0n && now_ !== null && then !== null && now_ >= min && then >= min;
  const used = eligible ? await creditsUsed(db, owner, now) : 0;
  return {
    ...base,
    eligible,
    balance: now_ === null ? null : formatUnits(now_, token.decimals),
    balance24hAgo: then === null ? null : formatUnits(then, token.decimals),
    freeRunsLeft: eligible ? Math.max(0, cfg.holder.freeRunsPerMonth - used) : 0,
    discountBps: eligible ? cfg.holder.discountBps : 0,
  };
}

/** The block closest to `target` (Unix seconds): an estimate from the block time, refined twice. */
async function blockAt(cfg: Config, target: number): Promise<bigint | null> {
  const chain = chainFor(cfg);
  const latest = await chain.latestBlock();
  let block = latest;
  let time = Number(await chain.blockTimestamp(latest));
  for (let i = 0; i < 3 && Math.abs(time - target) > SNAPSHOT_TOLERANCE_S / 2; i++) {
    const step = BigInt(Math.round(((time - target) * 1000) / cfg.blockTimeMs));
    block = block - step < 0n ? 0n : block - step > latest ? latest : block - step;
    time = Number(await chain.blockTimestamp(block));
  }
  return Math.abs(time - target) <= SNAPSHOT_TOLERANCE_S ? block : null;
}

export function sameAddress(a: string, b: Address | string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
