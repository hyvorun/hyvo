/**
 * `/v1/account`: HYVO holder utilities kept with the account (docs/OPEN_ITEMS.md item 33). A holder's watchlist of Pons
 * launches and the wallets they follow on /track, so both reach their other browsers. Everyone else keeps them in their
 * own browser, which needs nothing from this API.
 *
 * A holder is the same as everywhere else (lib/holder.ts): at least HOLDER_MIN HYVO in the signed-in wallet, now and
 * 24 hours earlier. Each request reads that from the chain, so each wallet may make LIST_REQUESTS_PER_MINUTE of them.
 * The lists are addresses only: nothing here reads, holds or moves anyone's tokens.
 */
import { TRACKED_MAX_HOLDER, TrackedRequest, WATCHLIST_MAX, WatchlistRequest } from "@hyvo/schema";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { requireSession } from "../lib/auth";
import { isoOrNull, nowS } from "../lib/clock";
import { config } from "../lib/config";
import { ApiError, readJson } from "../lib/errors";
import { holderStatus } from "../lib/holder";
import { rateLimit } from "../lib/ratelimit";

/** Requests a wallet may make a minute to these routes, reads and writes together. */
export const LIST_REQUESTS_PER_MINUTE = 30;

type ListName = "watchlist" | "tracked";

export const accountLists = new Hono<AppEnv>();

accountLists.use("*", requireSession);

/** Refuses a wallet that is not a holder now, with the rule in words. */
async function requireHolder(c: Context<AppEnv>, now: number): Promise<string> {
  const address = c.get("address");
  await rateLimit(c.env.DB, "lists", address.toLowerCase(), LIST_REQUESTS_PER_MINUTE, 60, now);
  const cfg = config(c.env);
  const holder = await holderStatus(c.env.DB, cfg, address, now);
  if (!holder.enabled) {
    throw new ApiError(403, "holder_only", "Lists saved with an account are for HYVO holders, and holder benefits are not on for this API. Your lists stay saved in this browser.");
  }
  if (!holder.eligible) {
    const read = holder.balance === null || holder.balance24hAgo === null ? " Its balance could not be read just now; try again shortly." : "";
    throw new ApiError(
      403,
      "holder_only",
      `Lists saved with an account are for HYVO holders: at least ${holder.minBalance} HYVO in this wallet, now and 24 hours earlier.${read} Your lists stay saved in this browser.`,
    );
  }
  return address.toLowerCase();
}

async function readList(db: D1Database, address: string, list: ListName): Promise<{ items: string[]; updatedAt: string | null }> {
  const row = await db
    .prepare("SELECT items_json, updated_at FROM account_lists WHERE address = ? AND list = ?")
    .bind(address, list)
    .first<{ items_json: string; updated_at: number }>();
  if (!row) return { items: [], updatedAt: null };
  const parsed: unknown = JSON.parse(row.items_json);
  return { items: Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [], updatedAt: isoOrNull(row.updated_at) };
}

/** The list once each address is kept once (in lowercase), in the order first given. */
export function uniqueAddresses(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.toLowerCase()))];
}

async function writeList(db: D1Database, address: string, list: ListName, items: string[], now: number): Promise<{ items: string[]; updatedAt: string | null }> {
  await db
    .prepare(
      `INSERT INTO account_lists (address, list, items_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(address, list) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`,
    )
    .bind(address, list, JSON.stringify(items), now)
    .run();
  return { items, updatedAt: isoOrNull(now) };
}

accountLists.get("/watchlist", async (c) => {
  const now = nowS();
  const address = await requireHolder(c, now);
  const { items, updatedAt } = await readList(c.env.DB, address, "watchlist");
  return c.json({ tokens: items.slice(0, WATCHLIST_MAX), updatedAt });
});

accountLists.put("/watchlist", async (c) => {
  const now = nowS();
  const { tokens } = await readJson(c, WatchlistRequest);
  const address = await requireHolder(c, now);
  const saved = await writeList(c.env.DB, address, "watchlist", uniqueAddresses(tokens), now);
  return c.json({ tokens: saved.items, updatedAt: saved.updatedAt });
});

accountLists.get("/tracked", async (c) => {
  const now = nowS();
  const address = await requireHolder(c, now);
  const { items, updatedAt } = await readList(c.env.DB, address, "tracked");
  return c.json({ wallets: items.slice(0, TRACKED_MAX_HOLDER), updatedAt });
});

accountLists.put("/tracked", async (c) => {
  const now = nowS();
  const { wallets } = await readJson(c, TrackedRequest);
  const address = await requireHolder(c, now);
  const saved = await writeList(c.env.DB, address, "tracked", uniqueAddresses(wallets), now);
  return c.json({ wallets: saved.items, updatedAt: saved.updatedAt });
});
