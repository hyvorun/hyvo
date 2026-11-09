// A from-scratch ABI decoder, the counterpart of abi-encode.ts, and function-level helpers driven by JSON ABI
// items. Return data can come from a hostile contract, so every offset and length is bounds-checked against the
// data before it is used, and a malformed answer throws AbiDecodeError instead of allocating or looping on it.
// Checked against viem in the tests.

import type { Hex } from "../types.js";
import { funcSelector, strip0x, toChecksumAddress } from "./abi.js";
import { type AbiParam, arrayMatch, encodeParameters, isDynamic } from "./abi-encode.js";

export class AbiDecodeError extends Error {
  override readonly name = "AbiDecodeError";
}

/** A JSON ABI function item, as solc and Foundry write it. */
export interface AbiFunction {
  type: "function";
  name: string;
  inputs: readonly AbiParam[];
  outputs?: readonly AbiParam[];
  stateMutability?: string;
}

/** Bytes a static parameter takes in the head. */
function headSize(p: AbiParam): number {
  if (isDynamic(p)) return 32;
  const arr = arrayMatch(p.type);
  if (arr) return Number(arr.size) * headSize({ type: arr.base, components: p.components });
  if (p.type === "tuple") return (p.components ?? []).reduce((sum, c) => sum + headSize(c), 0);
  return 32;
}

class Reader {
  readonly length: number;

  constructor(readonly hex: string) {
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new AbiDecodeError("not hex bytes");
    this.length = hex.length / 2;
  }

  word(pos: number): string {
    if (!Number.isSafeInteger(pos) || pos < 0 || pos + 32 > this.length) {
      throw new AbiDecodeError(`read past the end of the data at byte ${pos}`);
    }
    return this.hex.slice(pos * 2, pos * 2 + 64);
  }

  uint(pos: number): bigint {
    return BigInt(`0x${this.word(pos)}`);
  }

  /** An offset or a length: must fit in the data. */
  size(pos: number): number {
    const v = this.uint(pos);
    if (v > BigInt(this.length)) throw new AbiDecodeError(`offset or length ${v} beyond ${this.length} bytes`);
    return Number(v);
  }

  bytes(pos: number, len: number): string {
    if (pos + len > this.length) throw new AbiDecodeError("bytes run past the end of the data");
    return this.hex.slice(pos * 2, (pos + len) * 2);
  }
}

function decodeParams(params: readonly AbiParam[], r: Reader, base: number): unknown[] {
  const out: unknown[] = [];
  let head = base;
  for (const p of params) {
    if (isDynamic(p)) {
      const offset = r.size(head);
      out.push(decodeOne(p, r, base + offset));
    } else {
      out.push(decodeOne(p, r, head));
    }
    head += headSize(p);
  }
  return out;
}

function decodeOne(p: AbiParam, r: Reader, pos: number): unknown {
  const arr = arrayMatch(p.type);
  if (arr) {
    const elem: AbiParam = { type: arr.base, components: p.components };
    if (arr.size === "") {
      const n = r.size(pos);
      // Every element takes its head size (a word for a dynamic one), so the count is bounded by the data after it.
      const per = headSize(elem);
      if (per === 0) throw new AbiDecodeError(`unsupported array element: ${elem.type}`);
      if (n * per > r.length - pos - 32) throw new AbiDecodeError("array longer than its data");
      return decodeParams(
        Array.from({ length: n }, () => elem),
        r,
        pos + 32,
      );
    }
    return decodeParams(
      Array.from({ length: Number(arr.size) }, () => elem),
      r,
      pos,
    );
  }
  if (p.type === "tuple") {
    const comps = p.components ?? [];
    const values = decodeParams(comps, r, pos);
    if (comps.length > 0 && comps.every((c) => c.name)) {
      return Object.fromEntries(comps.map((c, i) => [c.name, values[i]]));
    }
    return values;
  }
  if (p.type === "bytes" || p.type === "string") {
    const len = r.size(pos);
    const hex = r.bytes(pos + 32, len);
    if (p.type === "bytes") return `0x${hex}`;
    const raw = new Uint8Array(len);
    for (let i = 0; i < len; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(raw);
  }
  const word = r.word(pos);
  const uint = /^uint(\d*)$/.exec(p.type);
  if (uint) return BigInt(`0x${word}`);
  const int = /^int(\d*)$/.exec(p.type);
  if (int) {
    const v = BigInt(`0x${word}`);
    return v >= 1n << 255n ? v - (1n << 256n) : v;
  }
  if (p.type === "address") return toChecksumAddress(`0x${word.slice(24)}`);
  if (p.type === "bool") return BigInt(`0x${word}`) !== 0n;
  const fixed = /^bytes([1-9]|[12]\d|3[0-2])$/.exec(p.type);
  if (fixed) return `0x${word.slice(0, Number(fixed[1]) * 2)}`;
  throw new AbiDecodeError(`unsupported ABI type: ${p.type}`);
}

/** Decodes ABI-encoded data for a parameter list. Named tuples come back as objects, everything else as arrays. */
export function decodeParameters(params: readonly AbiParam[], data: string): unknown[] {
  return decodeParams(params, new Reader(strip0x(data)), 0);
}

/** The canonical type of a parameter, with tuples spelled out: (address,uint24)[] and so on. */
export function canonicalType(p: AbiParam): string {
  if (p.type.startsWith("tuple")) {
    return `(${(p.components ?? []).map(canonicalType).join(",")})${p.type.slice("tuple".length)}`;
  }
  return p.type;
}

export function functionSignature(item: AbiFunction): string {
  return `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

export function encodeFunctionCall(item: AbiFunction, args: readonly unknown[]): Hex {
  return `${funcSelector(functionSignature(item))}${strip0x(encodeParameters(item.inputs, args))}` as Hex;
}

export function decodeFunctionOutput(item: AbiFunction, data: string): unknown[] {
  return decodeParameters(item.outputs ?? [], data);
}

/** Builds a function item from a human-readable signature with plain types, e.g. 'getPair(address,address)'. */
export function fn(signature: string, outputs: readonly string[] = []): AbiFunction {
  const m = /^(\w+)\((.*)\)$/.exec(signature);
  if (!m) throw new Error(`invalid signature: ${signature}`);
  const inputs = m[2] ? m[2].split(",").map((t) => ({ type: t.trim() })) : [];
  return { type: "function", name: m[1]!, inputs, outputs: outputs.map((t) => ({ type: t })) };
}
