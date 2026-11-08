/**
 * Canonical hashing of `run.json` (docs/RUN_FORMAT.md, "Hashing"):
 *
 *   hash = "0x" + lowercase_hex(keccak256(utf8(JCS(run without its top-level "hash"))))
 *
 * JCS is RFC 8785; keccak256 is Ethereum's original Keccak-256, not NIST SHA3-256.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { RunId } from "./run";

export type Hex = `0x${string}`;

export interface RunHashCheck {
  ok: boolean;
  /** Hash recomputed from the run's content: the value `hash` must have. */
  expected: Hex;
  /** The run's recorded `hash` member, or null when it is missing or not a string. */
  actual: string | null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * RFC 8785 canonical JSON text of a JSON value. Throws on input JSON cannot represent
 * (undefined, NaN, Infinity, BigInt, cycles) and on strings with lone surrogates, which
 * RFC 8785 excludes.
 */
export function canonicalJson(value: unknown): string {
  const json = canonicalize(value);
  if (json === undefined) throw new TypeError("value has no JSON representation");
  return json;
}

/** Keccak-256 of the UTF-8 bytes of `s`, as 0x-prefixed lowercase hex. */
export function keccak256Utf8(s: string): Hex {
  if (LONE_SURROGATE.test(s)) throw new TypeError("string has a lone surrogate, so it has no UTF-8 encoding");
  return `0x${bytesToHex(keccak_256(utf8ToBytes(s)))}`;
}

/** Run hash: keccak256 of the JCS form of `run` without its top-level `hash` member. */
export function hashRun(run: Readonly<Record<string, unknown>>): Hex {
  if (typeof run !== "object" || run === null || Array.isArray(run)) {
    throw new TypeError("run must be a JSON object");
  }
  const { hash: _recorded, ...content } = run;
  return keccak256Utf8(canonicalJson(content));
}

/** Recomputes the run hash and compares it with the recorded `hash` member. */
export function verifyRunHash(run: Readonly<Record<string, unknown>>): RunHashCheck {
  const expected = hashRun(run);
  const actual = typeof run.hash === "string" ? run.hash : null;
  return { ok: actual === expected, expected, actual };
}

/** `scenarioHash` for the oracle: keccak256 of the JCS form of `run.scenario`. */
export function scenarioHash(scenario: Readonly<Record<string, unknown>>): Hex {
  return keccak256Utf8(canonicalJson(scenario));
}

/**
 * `runIdBytes32` for the oracle: the ULID after `run_`, decoded from Crockford base32 to its
 * 128-bit value, big-endian in the low 16 bytes of a bytes32 (high 16 bytes zero).
 */
export function runIdToBytes32(runId: string): Hex {
  if (!RunId.safeParse(runId).success) throw new TypeError(`not a valid runId: ${String(runId)}`);
  let value = 0n;
  for (const char of runId.slice("run_".length)) {
    value = (value << 5n) | BigInt(CROCKFORD.indexOf(char));
  }
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** Inverse of `runIdToBytes32`. Hex digits may be upper or lower case. */
export function bytes32ToRunId(hex: string): string {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new TypeError(`not a bytes32 hex string: ${String(hex)}`);
  }
  if (!/^0x0{32}/.test(hex)) throw new RangeError(`high 16 bytes must be zero for a runId: ${hex}`);
  let value = BigInt(hex);
  let ulid = "";
  for (let i = 0; i < 26; i++) {
    ulid = CROCKFORD.charAt(Number(value & 31n)) + ulid;
    value >>= 5n;
  }
  return `run_${ulid}`;
}
