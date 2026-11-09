// A from-scratch ABI encoder for static and dynamic types: bytes, string, arrays and tuples with correct
// head/tail offsets. Zero runtime dependencies; checked byte for byte against viem in the tests.
//
// Descriptors mirror viem's AbiParameter shape so the two can be compared one to one.

import { toHex } from "./keccak.js";

export type AbiParam = { type: string; name?: string; components?: readonly AbiParam[] };

const strip = (h: string): string => (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h);
const padLeft = (hex: string): string => hex.padStart(64, "0");
const padRight = (hex: string): string =>
  hex.length % 64 === 0 ? hex : hex.padEnd(hex.length + (64 - (hex.length % 64)), "0");

function uintHex(v: bigint): string {
  if (v < 0n) throw new Error("negative value for an unsigned type");
  const h = v.toString(16);
  if (h.length > 64) throw new Error("uint exceeds 256 bits");
  return padLeft(h);
}

function intHex(v: bigint): string {
  const mod = 1n << 256n;
  const x = ((v % mod) + mod) % mod; // two's complement wrap
  return padLeft(x.toString(16));
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new Error(`expected an integer value, got ${typeof v}`);
}

export const arrayMatch = (type: string): { base: string; size: string } | null => {
  const m = /^(.*)\[(\d*)\]$/.exec(type);
  return m ? { base: m[1]!, size: m[2]! } : null;
};

export function isDynamic(p: AbiParam): boolean {
  if (p.type === "bytes" || p.type === "string") return true;
  const arr = arrayMatch(p.type);
  if (arr) {
    if (arr.size === "") return true; // T[] dynamic array
    return isDynamic({ type: arr.base, components: p.components }); // T[k] dynamic iff element is
  }
  if (p.type === "tuple") return (p.components ?? []).some(isDynamic);
  return false;
}

// Encodes a single value (returns hex WITHOUT 0x). Dynamic values return their full body (e.g. length word +
// data); the head/tail wiring is done by encodeParams.
function encodeOne(p: AbiParam, v: unknown): string {
  const arr = arrayMatch(p.type);
  if (arr) {
    const elem: AbiParam = { type: arr.base, components: p.components };
    const values = v as unknown[];
    if (!Array.isArray(values)) throw new Error(`expected array for ${p.type}`);
    if (arr.size !== "" && values.length !== Number(arr.size)) {
      throw new Error(`fixed array ${p.type} expects ${arr.size} items`);
    }
    const body = encodeParams(
      values.map(() => elem),
      values,
    );
    return arr.size === "" ? uintHex(BigInt(values.length)) + body : body;
  }
  if (p.type === "tuple") {
    const comps = p.components ?? [];
    // A struct may be given as an object keyed by component names, or as an array in order.
    const values = Array.isArray(v) ? v : comps.map((c) => (v as Record<string, unknown>)[c.name ?? ""]);
    return encodeParams(comps, values);
  }
  if (p.type === "bytes") {
    const s = strip(v as string);
    return uintHex(BigInt(s.length / 2)) + (s ? padRight(s) : "");
  }
  if (p.type === "string") {
    const s = toHex(new TextEncoder().encode(String(v)));
    return uintHex(BigInt(s.length / 2)) + (s ? padRight(s) : "");
  }
  if (/^uint\d*$/.test(p.type)) return uintHex(toBigInt(v));
  if (/^int\d*$/.test(p.type)) return intHex(toBigInt(v));
  if (p.type === "address") return padLeft(strip(v as string).toLowerCase());
  if (p.type === "bool") return padLeft(v ? "1" : "0");
  if (/^bytes([1-9]|[12]\d|3[0-2])$/.test(p.type)) return padRight(strip(v as string));
  throw new Error(`unsupported ABI type: ${p.type}`);
}

// Head/tail encoding of a parameter list (also used for tuples and array bodies).
function encodeParams(params: readonly AbiParam[], values: readonly unknown[]): string {
  if (params.length !== values.length) throw new Error("params/values length mismatch");
  const parts = params.map((p, i) => ({ dyn: isDynamic(p), enc: encodeOne(p, values[i]) }));
  let headLen = 0;
  for (const { dyn, enc } of parts) headLen += dyn ? 32 : enc.length / 2;

  const heads: string[] = [];
  const tails: string[] = [];
  let offset = headLen;
  for (const { dyn, enc } of parts) {
    if (dyn) {
      heads.push(uintHex(BigInt(offset)));
      tails.push(enc);
      offset += enc.length / 2;
    } else {
      heads.push(enc);
    }
  }
  return heads.join("") + tails.join("");
}

/** ABI-encodes a parameter list, returning 0x-prefixed data. */
export function encodeParameters(params: readonly AbiParam[], values: readonly unknown[]): `0x${string}` {
  return `0x${encodeParams(params, values)}`;
}
