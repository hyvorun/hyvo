/**
 * A token's top holders and creator from Blockscout's index, read with the Worker's own key (env.BLOCKSCOUT_API_KEY,
 * docs/OPEN_ITEMS.md items 24 and 30), for `GET /v1/check/:token/holders` and for the holder and deployer findings
 * of `GET /v1/check/:token` and MCP's check_token (docs/API.md, "Hyvo Check"). Without the key nothing here runs.
 *
 * - The key stays in the Worker. It goes to Blockscout in the query of three requests and nowhere else: what this
 *   API answers is parsed fields (addresses, digits, a transaction hash) and fixed phrases, never Blockscout's text,
 *   and the logs carry counts and statuses. `redact` takes it out of anything logged all the same.
 * - Cache. The facts, not Blockscout's whole answers, are kept per token for the rest of a ten-minute window in the
 *   Cache API, and both routes read the same entry. Facts with a part Blockscout did not answer (a 429, a timeout), or
 *   with a page that lists no holder, are not kept, so the next request asks again.
 * - Limits. A read is three requests to Blockscout, whose free tier allows 5 requests a second and 100,000 credits a
 *   day (item 24). Each IP may start HOLDER_READS_PER_MINUTE reads a minute through the holders route, and the Worker
 *   as a whole BLOCKSCOUT_READS_PER_MINUTE and BLOCKSCOUT_READS_PER_DAY; past that, or for BLOCKSCOUT_PAUSE_S after
 *   Blockscout answers 429, the facts say so and nothing is asked. Inside a check the three requests
 *   join its own: at most 46 + 3 = 49 of the 50 subrequests a free-plan request may make (check.ts).
 * - CPU. One JSON.parse per answer (the holders page is Blockscout's first page, 50 rows), and only the fields
 *   above are kept.
 */
import {
  parseHolderFacts,
  readHolderFacts,
  serializeHolderFacts,
  toChecksumAddress,
  type FetchLike,
  type HolderFacts,
  type JsonHolderFacts,
} from "@hyvo/check";
import type { Env } from "../env";
import type { CheckClient } from "./check";
import { iso } from "./clock";
import { ApiError } from "./errors";
import { rateLimit } from "./ratelimit";

/** How long the facts are kept: the rest of a ten-minute window. */
export const HOLDERS_WINDOW_S = 600;
/** Reads one IP may start a minute through `GET /v1/check/:token/holders`. An answer from the cache does not count. */
export const HOLDER_READS_PER_MINUTE = 10;
/** Reads the whole Worker may start a minute: 3 requests each, 3 a second on average, under Blockscout's 5. */
export const BLOCKSCOUT_READS_PER_MINUTE = 60;
/**
 * Reads the whole Worker may start in a UTC day: 90,000 requests, under the free tier's 100,000 daily credits if a
 * request costs one (item 30: not measured yet), leaving the rest of the key's day to the engine's Wallet Clone,
 * which uses the same key. Without it, the minute's limit alone allows 259,200 requests a day.
 */
export const BLOCKSCOUT_READS_PER_DAY = 30_000;
/** The rate-limit scope of the day's count. The cron keeps its rows for the whole day (scheduled.ts). */
export const BLOCKSCOUT_DAY_SCOPE = "blockscout-day";
/** After Blockscout answers 429, this isolate asks it nothing for this long, rather than at once again. */
export const BLOCKSCOUT_PAUSE_S = 30;
/** Blockscout's own keyed API for chain 4663 (item 24). */
const BLOCKSCOUT_API_URL = "https://api.blockscout.com/4663/api";
/** A request to Blockscout that has not answered by then counts as no answer. */
const REQUEST_TIMEOUT_MS = 5_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const JSON_TYPE = "application/json; charset=utf-8";

/** `GET /v1/check/:token/holders`: the facts (bigints as decimal strings), and where and when they were read. */
export type HoldersResponse = JsonHolderFacts & {
  token: string;
  /** When Hyvo's API read Blockscout's index: an answer from the cache is up to ten minutes old. */
  readAt: string;
  disclaimer: string;
};

export interface HoldersAnswer {
  /** The JSON body, exactly as cached. */
  text: string;
  facts: HolderFacts;
  hit: boolean;
  /** Seconds the answer holds: the rest of the window, or 0 when it was not kept. */
  maxAgeS: number;
}

let fetchOverride: FetchLike | null = null;
/** Until when (Unix seconds) this isolate asks Blockscout nothing: set by a 429. */
let pausedUntil = 0;

/** Tests only: answer Blockscout's requests with `fetch`, and forget any 429; `null` restores the Worker's own fetch. */
export function setHoldersFetch(next: FetchLike | null): void {
  fetchOverride = next;
  pausedUntil = 0;
}

/** The Worker's Blockscout key, or null: without one, top holders are not read. */
export function blockscoutKey(env: Env): string | null {
  const key = (env.BLOCKSCOUT_API_KEY ?? "").trim();
  return key.length > 0 ? key : null;
}

/** "Blockscout's index, read through Hyvo's API at 07:12 UTC on 2026-11-09": the evidence's words for the source. */
export function holdersSource(readAt: number): string {
  const time = iso(readAt);
  return `Blockscout's index, read through Hyvo's API at ${time.slice(11, 16)} UTC on ${time.slice(0, 10)}`;
}

/** `text` with the key taken out, for anything that is logged. */
export function redact(text: string, key: string | null): string {
  if (!key) return text;
  return text.split(key).join("[key]").split(encodeURIComponent(key)).join("[key]");
}

/**
 * `GET /v1/check/:token/holders`. Errors are `ApiError`s: 400 for something that is not an address, 503 when this
 * API has no Blockscout key, 429 past the per-IP limit. What Blockscout did not answer is in the facts, with why.
 */
export async function tokenHolders(env: Env, address: string, client: CheckClient, now: number): Promise<HoldersAnswer> {
  const token = address.trim();
  if (!ADDRESS.test(token)) throw new ApiError(400, "bad_request", "not an address: expected 0x and 40 hex characters");
  const key = blockscoutKey(env);
  if (!key) throw new ApiError(503, "holders_disabled", "top holders are not read on this API: it has no Blockscout key");
  return holderFacts(env, key, toChecksumAddress(token), client, now, { perIp: true });
}

/**
 * The facts for `token` (checksummed) in the current window: from the cache, or read from Blockscout now. With
 * `perIp`, a read counts against the caller's limit (and past it throws a 429 `ApiError`); a check, already limited,
 * reads without. Never throws otherwise: what could not be read is in the facts.
 */
export async function holderFacts(
  env: Env,
  key: string,
  token: string,
  client: CheckClient,
  now: number,
  options: { perIp: boolean; signal?: AbortSignal },
): Promise<HoldersAnswer> {
  const window = Math.floor(now / HOLDERS_WINDOW_S);
  const maxAgeS = (window + 1) * HOLDERS_WINDOW_S - now;
  const cacheKey = new Request(`${client.origin}/v1/check/${token.toLowerCase()}/holders?window=${window}`);
  const cached = await fromCache(cacheKey);
  const kept = cached === null ? null : parseHolderFacts(safeJson(cached));
  if (cached !== null && kept) return { text: cached, facts: kept, hit: true, maxAgeS };

  if (options.perIp) await rateLimit(env.DB, "holders", client.ip, HOLDER_READS_PER_MINUTE, 60, now);
  const started = Date.now();
  let facts: HolderFacts | null = null;
  let why: string | null = null;
  let settled = false;
  let limited = false;
  let requests = 0;
  try {
    why = await mayNotRead(env, now);
    if (why === null) {
      const read = await readHolderFacts(token, {
        blockscoutKey: key,
        blockscoutUrl: BLOCKSCOUT_API_URL,
        source: holdersSource(now),
        timeoutMs: REQUEST_TIMEOUT_MS,
        retry429: false,
        signal: options.signal,
        ...(fetchOverride ? { fetch: fetchOverride } : {}),
      });
      ({ settled, requests, limited, ...facts } = read);
      if (limited) pausedUntil = Math.max(pausedUntil, now + BLOCKSCOUT_PAUSE_S);
    }
  } catch (error) {
    why = "Hyvo's API could not read Blockscout's index just now";
    console.warn(redact(JSON.stringify({ level: "warn", event: "holders_failed", token, error: String(error).slice(0, 200) }), key));
  }
  facts ??= { source: holdersSource(now), totalSupply: null, holderCount: null, holders: null, holdersMissing: why, creator: null, creatorMissing: why };

  const body: HoldersResponse = {
    token,
    ...serializeHolderFacts(facts),
    readAt: iso(now),
    disclaimer: `Read from Blockscout's index through Hyvo's API at ${iso(now)}, not at one block. Not a trading signal.`,
  };
  const text = JSON.stringify(body);
  console.log(
    redact(
      JSON.stringify({
        level: "info",
        event: "holders",
        token,
        ms: Date.now() - started,
        requests,
        settled,
        limited,
        holders: facts.holders?.length ?? null,
        creator: facts.creator !== null,
      }),
      key,
    ),
  );
  if (!settled) return { text, facts, hit: false, maxAgeS: 0 };
  client.defer(toCache(cacheKey, text, maxAgeS));
  return { text, facts, hit: false, maxAgeS };
}

/**
 * Null when the Worker may read Blockscout now, or why not, in the facts' words: a 429 in the last
 * BLOCKSCOUT_PAUSE_S in this isolate, then the Worker's reads this minute, then its reads this UTC day. The day's
 * count is taken last, so reads the minute's limit turns away do not use it up.
 */
async function mayNotRead(env: Env, now: number): Promise<string | null> {
  if (pausedUntil > now) {
    return `Blockscout's API answered 429 to Hyvo's API in the last ${BLOCKSCOUT_PAUSE_S} s; ask again in ${pausedUntil - now} s`;
  }
  const spent = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 429;
  try {
    await rateLimit(env.DB, "blockscout", "worker", BLOCKSCOUT_READS_PER_MINUTE, 60, now);
  } catch (error) {
    if (spent(error)) return `Hyvo's API has read Blockscout's index as often as it may this minute; ask again in ${error.retryAfterS ?? 60} s`;
    throw error;
  }
  try {
    await rateLimit(env.DB, BLOCKSCOUT_DAY_SCOPE, "worker", BLOCKSCOUT_READS_PER_DAY, 86_400, now);
  } catch (error) {
    if (spent(error)) return "Hyvo's API has read Blockscout's index as often as it may today; ask again after 00:00 UTC";
    throw error;
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fromCache(key: Request): Promise<string | null> {
  try {
    const response = await caches.default.match(key);
    return response ? await response.text() : null;
  } catch {
    return null;
  }
}

async function toCache(key: Request, text: string, maxAgeS: number): Promise<void> {
  await caches.default.put(key, new Response(text, { headers: { "Content-Type": JSON_TYPE, "Cache-Control": `public, max-age=${maxAgeS}` } }));
}
