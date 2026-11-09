/**
 * Hyvo Check from the Worker (docs/API.md, "Hyvo Check"): one token's facts at one block, read with `@hyvo/check`
 * through the Worker's RPC_URLS, and kept in the Cache API for the rest of the minute. Read-only: an eth_call
 * needs no key, and nothing is signed, approved or sent.
 *
 * Fitted to the Workers Free plan (docs/OPEN_ITEMS.md item 21):
 * - Subrequests: 50 a request, and calls to the Cache API (match, put) share that quota (Cloudflare's Workers limits
 *   page, "Cache API limits", read 2026-11-09). A check makes at most 11 JSON-RPC calls (chain id, head, code, two
 *   proxy slots, three multicalls, an implementation's code, the probe, and a state-override test when the probe
 *   returns nothing), and sends each at most RPC_ATTEMPTS times across the first two URLs of RPC_URLS: at most 33
 *   requests, plus 2 to Sourcify, plus a match and a put for the answer in the Cache API: 37.
 *   Measured on 2026-11-09 against dRPC: 7 to 10 JSON-RPC requests and 1 or 2 to Sourcify per token.
 * - Blockscout, with the Worker's key (BLOCKSCOUT_API_KEY), answers for the top holders and the creator: three
 *   requests beside the chain reads and a match and a put for the facts' own cache entry, or the match alone when
 *   the token's facts are in the cache (lib/holders.ts). That makes at most 42 of the 50. Without the key, the holder
 *   check is left out and the answer says so (`skippedByApi`).
 * - CPU. Measured in Node 24 with recorded answers replayed: 2 to 4 ms for a check on a warm isolate. The first
 *   check on a cold isolate costs more, as the first request of every route does (item 21).
 */
import {
  CheckError,
  checkToken,
  serializeReport,
  type CheckOptions,
  type CheckReport,
  type FetchLike,
  type JsonCheckReport,
} from "@hyvo/check";
import type { Context } from "hono";
import type { Env } from "../env";
import { inBackground } from "./background";
import { iso } from "./clock";
import { config } from "./config";
import { ApiError } from "./errors";
import { blockscoutKey, holderFacts } from "./holders";
import { clientIp, rateLimit } from "./ratelimit";

/** One check per token per minute (about 600 blocks at 0.1 s); every request in the minute gets its answer. */
export const CHECK_WINDOW_S = 60;
/** Checks one IP may start a minute. An answer from the cache does not count. */
export const CHECKS_PER_MINUTE = 10;
/** See the subrequest count above. */
const MAX_RPC_URLS = 2;
/** Requests one JSON-RPC call may send: the first URL, the second, then the first again after a pause. */
export const RPC_ATTEMPTS = 3;
/** dRPC answers or gives up within 2 s (item 3); a request that hangs moves on to the next URL after this. */
const REQUEST_TIMEOUT_MS = 5_000;
const ROBINHOOD_CHAIN_ID = 4663;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const JSON_TYPE = "application/json; charset=utf-8";

/**
 * What this API leaves out of every report when it has no Blockscout key, and why. The findings themselves say
 * `skipped`. With the key nothing is left out on purpose: a part Blockscout did not answer is `skipped` in its
 * finding, with the reason.
 */
export const SKIPPED_BY_API: { id: "holders"; reason: string }[] = [
  {
    id: "holders",
    reason:
      "Top holders come from Blockscout, which needs an API key, and this API has none set. @hyvo/check reads them with a key of your own (blockscoutKey).",
  },
];

/** `GET /v1/check/:token`: the report of `@hyvo/check` (bigints as decimal strings) and what this API adds. */
export type CheckResponse = JsonCheckReport & {
  /** When the check ran: an answer from the cache is up to a minute old. */
  checkedAt: string;
  /** Empty when the API has a Blockscout key. */
  skippedByApi: { id: "holders"; reason: string }[];
  /** "Measured on-chain at block N. Not a trading signal." */
  disclaimer: string;
};

/** Who asks, as the rate limit and the cache need it. */
export interface CheckClient {
  ip: string;
  /** The API's origin: the cache key is a URL under it. */
  origin: string;
  /** Work to finish after the answer (`waitUntil`). */
  defer: (work: Promise<unknown>) => void;
}

export interface CheckAnswer {
  /** The JSON body, exactly as cached. */
  text: string;
  hit: boolean;
  /** Seconds until the minute ends and the next request checks again. */
  maxAgeS: number;
}

interface Runtime {
  /** null: the Worker's own fetch. */
  fetch: FetchLike | null;
  /** A check that has not finished by then is aborted. */
  deadlineMs: number;
}

const DEFAULTS: Runtime = { fetch: null, deadlineMs: 25_000 };
let runtime: Runtime = DEFAULTS;

/** Tests only: answer the check's requests with `fetch`, or give up sooner; `null` restores the defaults. */
export function setCheckRuntime(next: Partial<Runtime> | null): void {
  runtime = next ? { ...DEFAULTS, ...next } : DEFAULTS;
}

export function checkClient(c: Context): CheckClient {
  return { ip: clientIp(c), origin: new URL(c.req.url).origin, defer: (work) => inBackground(c, work) };
}

/**
 * The check of `address` for the current minute: from the cache, or read from the chain now (rate limited).
 * Errors are `ApiError`s: 400 for something that is not an address, 404 when there is no token at the address,
 * 503 when the chain cannot be read or the check is off, 504 when it took too long. Errors are not cached.
 */
export async function tokenCheck(env: Env, address: string, client: CheckClient, now: number): Promise<CheckAnswer> {
  const token = address.trim();
  if (!ADDRESS.test(token)) throw new ApiError(400, "bad_request", "not an address: expected 0x and 40 hex characters");
  const cfg = config(env);
  if (cfg.rpcUrls.length === 0 || cfg.chainId !== ROBINHOOD_CHAIN_ID) {
    throw new ApiError(503, "check_disabled", "Hyvo Check is not configured on this API");
  }

  const window = Math.floor(now / CHECK_WINDOW_S);
  const maxAgeS = (window + 1) * CHECK_WINDOW_S - now;
  const key = new Request(`${client.origin}/v1/check/${token.toLowerCase()}?window=${window}`);
  const cached = await fromCache(key);
  if (cached !== null) return { text: cached, hit: true, maxAgeS };

  await rateLimit(env.DB, "check", client.ip, CHECKS_PER_MINUTE, 60, now);
  const bsKey = blockscoutKey(env);
  // The token's holders and creator from Blockscout's index, from the cache or read beside the chain reads.
  const holders: HoldersFrom | null = bsKey
    ? async (checksummed, signal) => (await holderFacts(env, bsKey, checksummed, client, now, { perIp: false, signal })).facts
    : null;
  const report = await read(token, cfg.rpcUrls.slice(0, MAX_RPC_URLS), holders);
  const body: CheckResponse = {
    ...serializeReport(report),
    checkedAt: iso(now),
    skippedByApi: bsKey ? [] : SKIPPED_BY_API,
    disclaimer: `Measured on-chain at block ${report.block}. Not a trading signal.`,
  };
  const text = JSON.stringify(body);
  console.log(
    JSON.stringify({ level: "info", event: "check", token: report.token.address, block: body.block, ms: report.timings.totalMs, requests: report.timings.requests }),
  );
  client.defer(toCache(key, text, maxAgeS));
  return { text, hit: false, maxAgeS };
}

/**
 * The cached body, or null. Cloudflare documents a working Cache API for Workers on custom domains such as
 * api.hyvo.run, and it keeps entries in one data center; a cache that cannot be read counts as a miss.
 */
async function fromCache(key: Request): Promise<string | null> {
  try {
    const response = await caches.default.match(key);
    return response ? await response.text() : null;
  } catch {
    return null;
  }
}

/** Until the minute ends: the key names the minute, so no later request asks for it. */
async function toCache(key: Request, text: string, maxAgeS: number): Promise<void> {
  await caches.default.put(key, new Response(text, { headers: { "Content-Type": JSON_TYPE, "Cache-Control": `public, max-age=${maxAgeS}` } }));
}

type HoldersFrom = NonNullable<CheckOptions["holders"]>;

async function read(token: string, rpcUrls: string[], holders: HoldersFrom | null): Promise<CheckReport> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), runtime.deadlineMs);
  try {
    return await checkToken(token, {
      rpcUrls,
      rpcAttempts: RPC_ATTEMPTS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal: deadline.signal,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      ...(holders ? { holders } : {}),
    });
  } catch (error) {
    throw error instanceof CheckError ? apiError(error) : error;
  } finally {
    clearTimeout(timer);
  }
}

function apiError(error: CheckError): ApiError {
  switch (error.code) {
    case "invalid_address":
      return new ApiError(400, "bad_request", error.message);
    case "not_a_contract":
    case "not_a_token":
      return new ApiError(404, error.code, error.message);
    case "aborted":
      return new ApiError(504, "check_timeout", `the check did not finish within ${runtime.deadlineMs / 1000} s; ask again shortly`, 10);
    case "wrong_chain":
    case "rpc":
      console.warn(JSON.stringify({ level: "warn", event: "check_chain_failed", code: error.code, error: error.message.slice(0, 300) }));
      return new ApiError(
        503,
        "chain_unavailable",
        error.code === "wrong_chain" ? error.message : "Robinhood Chain could not be read right now; ask again shortly",
        10,
      );
  }
}
