/**
 * `GET /v1/launches/creator/:address`: every Pons V2 launch by one wallet, from the factory's TokenLaunched logs in
 * Blockscout's index (docs/API.md, "Hyvo Launches"; docs/OPEN_ITEMS.md item 32). TokenLaunched indexes the deployer
 * as topic 3, so one getLogs query (the factory, topic 0, topic 3) covers the factory's whole history, which the
 * public RPC endpoints cannot (10,000 to 250,000 blocks a query, item 29). The web app then reads each curve's state
 * now from the chain itself.
 *
 * - Key, limits and pause are holders.ts's: the key goes to Blockscout in the query and nowhere else (`redact` takes
 *   it out of anything logged), each lookup counts once against BLOCKSCOUT_READS_PER_MINUTE and _PER_DAY, and a 429
 *   from Blockscout pauses every Blockscout read of this isolate for BLOCKSCOUT_PAUSE_S.
 * - Paging. Blockscout answers at most 1,000 logs a query and documents no paging, so a full page is followed by one
 *   that starts at its last block, at most MAX_PAGES requests in all; past that the answer says `complete: false`.
 * - Cache. The answer is kept for the rest of a five-minute window in the Cache API. An answer with a part Blockscout
 *   did not give is not kept, so the next request asks again.
 * - Subrequests: the cache's match and put, and at most MAX_PAGES requests to Blockscout: 5 of the free plan's 50.
 */
import {
  LOGS_PER_PAGE,
  PONS_V2_FACTORY,
  PONS_V2_FACTORY_BLOCK,
  creatorLaunchToJson,
  creatorLogsQuery,
  mergeCreatorPages,
  nextPageFrom,
  parseCreatorLogs,
  type CreatorLaunch,
} from "@hyvo/launches/creator";
import type { CreatorLaunchesResponse } from "@hyvo/schema";
import { getAddress } from "viem";
import type { Env } from "../env";
import type { CheckClient } from "./check";
import { iso } from "./clock";
import { ApiError } from "./errors";
import { BLOCKSCOUT_API_URL, blockscoutKey, mayNotRead, pauseBlockscout, redact } from "./holders";
import { rateLimit } from "./ratelimit";

/** How long an answer is kept: the rest of a five-minute window. */
export const CREATOR_WINDOW_S = 300;
/** Lookups one IP may start a minute. An answer from the cache does not count. */
export const CREATOR_READS_PER_MINUTE = 10;
/** Requests to Blockscout per lookup at most: 3,000 launches. */
export const MAX_PAGES = 3;
const REQUEST_TIMEOUT_MS = 5_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const JSON_TYPE = "application/json; charset=utf-8";

type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

let fetchOverride: FetchLike | null = null;

/** Tests only: answer Blockscout's requests with `fetch`; `null` restores the Worker's own fetch. */
export function setCreatorFetch(next: FetchLike | null): void {
  fetchOverride = next;
}

export interface CreatorAnswer {
  text: string;
  hit: boolean;
  /** Seconds the answer holds: the rest of the window, or 0 when it was not kept. */
  maxAgeS: number;
}

/** "Blockscout's index of the Pons V2 factory's TokenLaunched logs, read through Hyvo's API at 07:12 UTC on 2026-11-09". */
export function creatorSource(now: number): string {
  const time = iso(now);
  return `Blockscout's index of the Pons V2 factory's TokenLaunched logs, read through Hyvo's API at ${time.slice(11, 16)} UTC on ${time.slice(0, 10)}`;
}

/**
 * The launches of `address`. Errors are `ApiError`s: 400 for something that is not an address, 503 when this API has
 * no Blockscout key, 429 past the per-IP limit. What Blockscout did not answer is in `missing`, with why.
 */
export async function creatorLaunches(env: Env, address: string, client: CheckClient, now: number): Promise<CreatorAnswer> {
  const raw = address.trim();
  if (!ADDRESS.test(raw)) throw new ApiError(400, "bad_request", "not an address: expected 0x and 40 hex characters");
  const key = blockscoutKey(env);
  if (!key) throw new ApiError(503, "creator_disabled", "a creator's launches are not read on this API: it has no Blockscout key");
  const creator = getAddress(raw.toLowerCase());

  const window = Math.floor(now / CREATOR_WINDOW_S);
  const maxAgeS = (window + 1) * CREATOR_WINDOW_S - now;
  const cacheKey = new Request(`${client.origin}/v1/launches/creator/${creator.toLowerCase()}?window=${window}`);
  const cached = await fromCache(cacheKey);
  if (cached !== null) return { text: cached, hit: true, maxAgeS };

  await rateLimit(env.DB, "creator", client.ip, CREATOR_READS_PER_MINUTE, 60, now);
  const started = Date.now();
  let missing: string | null = null;
  let launches: CreatorLaunch[] | null = null;
  let complete = false;
  let requests = 0;
  try {
    missing = await mayNotRead(env, now);
    if (missing === null) {
      const pages: CreatorLaunch[][] = [];
      let from: bigint | null = PONS_V2_FACTORY_BLOCK;
      while (from !== null && requests < MAX_PAGES) {
        requests += 1;
        const page = await askBlockscout(key, creator, from);
        if (typeof page === "string") {
          if (page === "429") pauseBlockscout(now);
          missing = page === "429" ? "Blockscout's API answered 429 to Hyvo's API: its free tier allows 5 requests a second; ask again in a minute" : page;
          break;
        }
        pages.push(page.launches);
        from = nextPageFrom(page, from);
        if (from === null) complete = page.rows < LOGS_PER_PAGE;
      }
      if (missing === null) launches = mergeCreatorPages(pages);
    }
  } catch (error) {
    missing = "Hyvo's API could not read Blockscout's index just now";
    console.warn(redact(JSON.stringify({ level: "warn", event: "creator_failed", creator, error: String(error).slice(0, 200) }), key));
  }

  const body: CreatorLaunchesResponse = {
    creator,
    factory: PONS_V2_FACTORY,
    launches: launches ? launches.map(creatorLaunchToJson) : null,
    complete: launches !== null && complete,
    missing,
    source: creatorSource(now),
    readAt: iso(now),
    disclaimer: `Launches from Blockscout's index of the factory's logs, read through Hyvo's API at ${iso(now)}. Each launch's state is read from the chain. Not a trading signal.`,
  };
  const text = JSON.stringify(body);
  console.log(
    redact(
      JSON.stringify({ level: "info", event: "creator", creator, ms: Date.now() - started, requests, launches: launches?.length ?? null, complete: body.complete, missing: missing !== null }),
      key,
    ),
  );
  if (launches === null) return { text, hit: false, maxAgeS: 0 };
  client.defer(toCache(cacheKey, text, maxAgeS));
  return { text, hit: false, maxAgeS };
}

/** One getLogs page, or why there is none: "429", or a sentence. Never names the URL (it carries the key). */
async function askBlockscout(key: string, creator: string, from: bigint): Promise<{ launches: CreatorLaunch[]; rows: number } | string> {
  const url = `${BLOCKSCOUT_API_URL}?${creatorLogsQuery(creator, from)}&apikey=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let status: number;
  let text: string;
  try {
    const fetchFn: FetchLike = fetchOverride ?? ((target, init) => fetch(target, init));
    const response = await fetchFn(url, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
    status = response.status;
    text = await response.text();
  } catch {
    return controller.signal.aborted ? "Blockscout's API did not answer in time" : "Blockscout's API could not be reached";
  } finally {
    clearTimeout(timer);
  }
  if (status === 429) return "429";
  if (status === 401 || status === 402 || status === 403) return "Blockscout's API refused the request";
  if (status !== 200) return `Blockscout's API answered ${status}`;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return parseCreatorLogs(json, creator) ?? "Blockscout's API gave no list of logs";
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
