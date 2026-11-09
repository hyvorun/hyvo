// Blockscout's keyed API, optional. robinhoodchain.blockscout.com answers programs with a bot challenge, and the
// keyed API (api.blockscout.com/4663/api) needs a free key from dev.blockscout.com: without one it answers 402
// (docs/OPEN_ITEMS.md item 24). With no key, Hyvo Check does not call Blockscout at all: the holder check is
// skipped, and Sourcify alone answers for verified source and the deployer.
//
// The routes are Blockscout's standard v2 API. `tokens/<address>`, `tokens/<address>/holders` and
// `smart-contracts/<address>` answered 200 with the fields read here on 2026-11-09 with a real key (item 24);
// `addresses/<address>` (the creator) is the same API's route, not yet tried with a key (item 30). Every method
// returns null on any failure, and the affected check is then reported "skipped".
//
// The key goes in the URL's query, as Blockscout asks. No message this file makes names a URL: errors name the
// host only (net.ts), so the key never reaches a report, an error or a log through it.

import type { Address, FetchLike, HolderFacts, Hex } from "../types.js";
import { HttpError, Net } from "../net.js";
import { isAddress, toChecksumAddress } from "./abi.js";
import { DEFAULT_TIMEOUT_MS, ROBINHOOD_CHAIN } from "./config.js";
import type { AbiItem } from "./sourcify.js";

export type BlockscoutContract = { verified: boolean; abi: AbiItem[] | null };

/** Blockscout's first page of holders holds 50; more is never kept. */
export const MAX_HOLDERS = 50;

export class BlockscoutClient {
  constructor(
    private readonly net: Net,
    private readonly apiBase: string, // e.g. https://api.blockscout.com/4663/api
    private readonly apiKey: string,
    /** One retry after a 429, 600 ms later. A Worker turns it off: each try is a subrequest. */
    private readonly retry429 = true,
  ) {}

  /** The HTTP status and parsed body (null when it is not JSON). Throws HttpError on a network failure or timeout. */
  async get(path: string): Promise<{ status: number; json: unknown }> {
    const url = `${this.apiBase.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(this.apiKey)}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.net.request("blockscout", url, { method: "GET", headers: { accept: "application/json" } });
      if (res.status === 429 && attempt === 0 && this.retry429) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        continue;
      }
      let json: unknown = null;
      try {
        json = JSON.parse(res.text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    }
  }

  /** Verification status and ABI; 404 means not verified. Null when Blockscout could not be asked. */
  async getContract(address: string): Promise<BlockscoutContract | null> {
    try {
      const { status, json } = await this.get(`/v2/smart-contracts/${address}`);
      if (status === 404) return { verified: false, abi: null };
      if (status === 200 && json && typeof json === "object") {
        const obj = json as Record<string, unknown>;
        const verified = Boolean(obj.is_verified ?? obj.abi ?? obj.source_code);
        const abi = Array.isArray(obj.abi) ? (obj.abi as AbiItem[]) : null;
        return { verified, abi };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Token totals. Null on failure. */
  async getTokenInfo(address: string): Promise<{ totalSupply: bigint | null; holders: number | null } | null> {
    try {
      const { status, json } = await this.get(`/v2/tokens/${address}`);
      return status === 200 ? parseTokenInfo(json) : null;
    } catch {
      return null;
    }
  }

  /** The largest holders, balance-descending (Blockscout's first page). Null on failure. */
  async getTokenHolders(address: string): Promise<{ address: Address; value: bigint }[] | null> {
    try {
      const { status, json } = await this.get(`/v2/tokens/${address}/holders`);
      return status === 200 ? parseHolders(json) : null;
    } catch {
      return null;
    }
  }

  /** The address that created the contract, and the creation transaction. Null on failure. */
  async getCreator(address: string): Promise<{ deployer: Address; creationTxHash: string | null } | null> {
    try {
      const { status, json } = await this.get(`/v2/addresses/${address}`);
      return status === 200 ? parseCreator(json) : null;
    } catch {
      return null;
    }
  }
}

/** `tokens/<address>`: the total supply and the holder count. Null when the body is not an object. */
export function parseTokenInfo(json: unknown): { totalSupply: bigint | null; holders: number | null } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const holders = o.holders ?? o.holders_count;
  const count = holders != null && holders !== "" ? Number(holders) : Number.NaN;
  return {
    totalSupply: typeof o.total_supply === "string" && /^\d{1,78}$/.test(o.total_supply) ? BigInt(o.total_supply) : null,
    holders: Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
}

/** `tokens/<address>/holders`: each holder's address and balance, at most MAX_HOLDERS. Null when there is no list. */
export function parseHolders(json: unknown): { address: Address; value: bigint }[] | null {
  if (!json || typeof json !== "object") return null;
  const items = (json as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  const out: { address: Address; value: bigint }[] = [];
  for (const it of items) {
    if (out.length >= MAX_HOLDERS) break;
    const row = it as Record<string, unknown> | null;
    const hash = (row?.address as Record<string, unknown> | undefined)?.hash;
    if (typeof hash !== "string" || !isAddress(hash)) continue;
    if (typeof row!.value !== "string" || !/^\d{1,78}$/.test(row!.value)) continue;
    out.push({ address: toChecksumAddress(hash), value: BigInt(row!.value) });
  }
  return out;
}

/** `addresses/<address>`: who created the contract, and in which transaction. Null when Blockscout names no creator. */
export function parseCreator(json: unknown): { deployer: Address; creationTxHash: Hex | null } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const creator = o.creator_address_hash;
  if (typeof creator !== "string" || !isAddress(creator)) return null;
  const tx = o.creation_transaction_hash;
  return {
    deployer: toChecksumAddress(creator),
    creationTxHash: typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx.toLowerCase() as Hex) : null,
  };
}

export interface HolderReadOptions {
  /** A Blockscout API key. It goes to Blockscout in the request's query and nowhere else. */
  blockscoutKey: string;
  /** Blockscout's keyed API for chain 4663. Default `https://api.blockscout.com/4663/api`. */
  blockscoutUrl?: string;
  /** Default `globalThis.fetch`. */
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Time limit for each request, in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** One retry after a 429. Default false: a 429 is reported, not waited out. */
  retry429?: boolean;
  /** Where the facts were read and when, as evidence names it (`HolderFacts.source`). */
  source: string;
}

/** Why one of Blockscout's answers could not be used, in plain words. */
function failure(what: string, outcome: { status: number } | HttpError): string {
  if (outcome instanceof HttpError) {
    return outcome.kind === "timeout"
      ? `Blockscout's API did not answer in time for ${what}`
      : outcome.kind === "aborted"
        ? `the read of ${what} was stopped`
        : `Blockscout's API could not be reached for ${what}`;
  }
  if (outcome.status === 429) return `Blockscout's API answered 429 for ${what}: its free tier allows 5 requests a second`;
  if (outcome.status === 401 || outcome.status === 402 || outcome.status === 403) return `Blockscout's API refused the request for ${what}`;
  if (outcome.status === 404) return `Blockscout's index does not list ${what}`;
  return `Blockscout's API answered ${outcome.status} for ${what}`;
}

/**
 * A token's holders and creator from Blockscout's index: three requests at once (`tokens/<address>`,
 * `tokens/<address>/holders`, `addresses/<address>`), each tried once unless `retry429`. Never throws: a part that
 * could not be read is null, with the reason in `holdersMissing` or `creatorMissing`.
 */
export async function readHolderFacts(token: string, options: HolderReadOptions): Promise<HolderFacts & { requests: number }> {
  const fetchFn = options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
  const base = { source: options.source, totalSupply: null, holderCount: null, holders: null, creator: null };
  if (!fetchFn || !isAddress(token)) {
    const why = !fetchFn ? "no fetch in this environment" : "not an address";
    return { ...base, holdersMissing: why, creatorMissing: why, requests: 0 };
  }
  const net = new Net({ fetch: fetchFn, signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const client = new BlockscoutClient(net, options.blockscoutUrl ?? ROBINHOOD_CHAIN.blockscoutApiUrl, options.blockscoutKey, options.retry429 ?? false);
  const address = toChecksumAddress(token);
  const ask = (path: string) =>
    client.get(path).then(
      (answer) => answer,
      (error: unknown) => (error instanceof HttpError ? error : new HttpError("Blockscout could not be read", "network")),
    );
  const [info, list, created] = await Promise.all([
    ask(`/v2/tokens/${address}`),
    ask(`/v2/tokens/${address}/holders`),
    ask(`/v2/addresses/${address}`),
  ]);

  const tokenInfo = !(info instanceof HttpError) && info.status === 200 ? parseTokenInfo(info.json) : null;
  const holders = !(list instanceof HttpError) && list.status === 200 ? parseHolders(list.json) : null;
  const creator = !(created instanceof HttpError) && created.status === 200 ? parseCreator(created.json) : null;
  const holdersMissing =
    holders !== null
      ? null
      : list instanceof HttpError || list.status !== 200
        ? failure("the token's holders", list)
        : "Blockscout's API gave no list of holders";
  const creatorMissing =
    creator !== null
      ? null
      : created instanceof HttpError || created.status !== 200
        ? failure("the token's creator", created)
        : "Blockscout's index names no creator for the token";
  return {
    source: options.source,
    totalSupply: tokenInfo?.totalSupply ?? null,
    holderCount: tokenInfo?.holders ?? null,
    holders,
    holdersMissing,
    creator: creator ? { address: creator.deployer, creationTxHash: creator.creationTxHash } : null,
    creatorMissing,
    requests: net.requests.blockscout,
  };
}
