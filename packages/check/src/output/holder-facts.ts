// HolderFacts as JSON (bigints as decimal strings) and back, for an API that hands them out and the page that
// reads them: `GET /v1/check/:token/holders` on Hyvo's API, read by the /check page. Parsing checks every field,
// so an answer that is not what it should be is no facts at all rather than wrong ones.

import { isAddress, toChecksumAddress } from "../chain/abi.js";
import { MAX_HOLDERS } from "../chain/blockscout.js";
import type { Address, Hex, HolderFacts } from "../types.js";

export interface JsonHolderFacts {
  source: string;
  totalSupply: string | null;
  holderCount: number | null;
  holders: { address: Address; value: string }[] | null;
  holdersMissing: string | null;
  creator: { address: Address; creationTxHash: Hex | null } | null;
  creatorMissing: string | null;
}

export function serializeHolderFacts(facts: HolderFacts): JsonHolderFacts {
  return {
    source: facts.source,
    totalSupply: facts.totalSupply === null ? null : facts.totalSupply.toString(),
    holderCount: facts.holderCount,
    holders: facts.holders === null ? null : facts.holders.map((h) => ({ address: h.address, value: h.value.toString() })),
    holdersMissing: facts.holdersMissing,
    creator: facts.creator,
    creatorMissing: facts.creatorMissing,
  };
}

const DIGITS = /^\d{1,78}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
/** Text that may reach evidence: a short line, no control characters. */
const LINE = /^[^\u0000-\u001f\u007f]{1,300}$/;

function text(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && LINE.test(value) ? value : undefined;
}

/** The facts in `json`, or null when any field is missing or not what it should be. */
export function parseHolderFacts(json: unknown): HolderFacts | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const source = text(o.source);
  const holdersMissing = text(o.holdersMissing ?? null);
  const creatorMissing = text(o.creatorMissing ?? null);
  if (!source || holdersMissing === undefined || creatorMissing === undefined) return null;

  let totalSupply: bigint | null = null;
  if (o.totalSupply !== null && o.totalSupply !== undefined) {
    if (typeof o.totalSupply !== "string" || !DIGITS.test(o.totalSupply)) return null;
    totalSupply = BigInt(o.totalSupply);
  }
  let holderCount: number | null = null;
  if (o.holderCount !== null && o.holderCount !== undefined) {
    if (typeof o.holderCount !== "number" || !Number.isSafeInteger(o.holderCount) || o.holderCount < 0) return null;
    holderCount = o.holderCount;
  }
  let holders: HolderFacts["holders"] = null;
  if (o.holders !== null && o.holders !== undefined) {
    if (!Array.isArray(o.holders) || o.holders.length > MAX_HOLDERS) return null;
    holders = [];
    for (const row of o.holders as unknown[]) {
      const r = row as Record<string, unknown> | null;
      if (!r || typeof r.address !== "string" || !isAddress(r.address) || typeof r.value !== "string" || !DIGITS.test(r.value)) return null;
      holders.push({ address: toChecksumAddress(r.address), value: BigInt(r.value) });
    }
  }
  let creator: HolderFacts["creator"] = null;
  if (o.creator !== null && o.creator !== undefined) {
    const c = o.creator as Record<string, unknown>;
    if (typeof c !== "object" || typeof c.address !== "string" || !isAddress(c.address)) return null;
    const tx = c.creationTxHash ?? null;
    if (tx !== null && (typeof tx !== "string" || !TX.test(tx))) return null;
    creator = { address: toChecksumAddress(c.address), creationTxHash: tx === null ? null : (tx.toLowerCase() as Hex) };
  }
  // A missing part carries its reason, so the page can say why.
  return {
    source,
    totalSupply,
    holderCount,
    holders,
    holdersMissing: holders === null ? (holdersMissing ?? "the holders were not given") : null,
    creator,
    creatorMissing: creator === null ? (creatorMissing ?? "the creator was not given") : null,
  };
}
