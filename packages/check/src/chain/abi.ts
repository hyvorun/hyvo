// Small ABI and hex helpers. No dependencies: selectors come from the verified keccak256 in keccak.ts, and the
// standard ones are also hardcoded below so a test can cross-check the two.

import type { Address, Hex } from "../types.js";
import { keccak256, toHex } from "./keccak.js";

export const SELECTORS = {
  name: "0x06fdde03", // name()
  symbol: "0x95d89b41", // symbol()
  decimals: "0x313ce567", // decimals()
  totalSupply: "0x18160ddd", // totalSupply()
  balanceOf: "0x70a08231", // balanceOf(address)
  owner: "0x8da5cb5b", // owner()
  getOwner: "0x893d20e8", // getOwner()
  implementation: "0x5c60da1b", // implementation()
} as const;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export function strip0x(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function isHex(s: string): s is Hex {
  return /^0x([0-9a-fA-F]{2})*$/.test(s);
}

const encoder = new TextEncoder();

export function utf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = strip0x(hex);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`not hex bytes: ${hex.slice(0, 20)}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${toHex(bytes)}`;
}

/** keccak256 of UTF-8 text, as 0x-prefixed hex. */
export function keccakText(text: string): Hex {
  return bytesToHex(keccak256(utf8Bytes(text)));
}

/** 4-byte function selector of a canonical signature, e.g. funcSelector('setFee(uint256)') -> '0x69fe0e2d'. */
export function funcSelector(signature: string): Hex {
  return `0x${toHex(keccak256(utf8Bytes(signature))).slice(0, 8)}`;
}

/** EIP-55 mixed-case checksum form of an address. */
export function toChecksumAddress(address: string): Address {
  if (!isAddress(address)) throw new Error(`invalid address: ${address}`);
  const lower = strip0x(address).toLowerCase();
  const hash = toHex(keccak256(utf8Bytes(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out as Address;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Display form for evidence strings, e.g. 0xAbC9…0F21. */
export function shortenAddress(address: string): string {
  if (!isAddress(address)) return address;
  const checksummed = toChecksumAddress(address);
  return `${checksummed.slice(0, 6)}…${checksummed.slice(-4)}`;
}

export function decodeUint(hex: string): bigint {
  const clean = strip0x(hex);
  if (clean.length === 0) return 0n;
  return BigInt(`0x${clean.slice(0, 64)}`);
}

export function decodeUint8(hex: string): number {
  return Number(decodeUint(hex) & 0xffn);
}

export function decodeAddress(hex: string): Address {
  const clean = strip0x(hex).slice(0, 64).padStart(64, "0");
  return toChecksumAddress(`0x${clean.slice(24)}`); // last 20 bytes of the first 32-byte word
}

export function decodeBool(hex: string): boolean {
  return decodeUint(hex) !== 0n;
}

/** A 32-byte word for an unsigned integer. */
export function uintWord(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new Error("uint out of range");
  return value.toString(16).padStart(64, "0");
}

/** A 32-byte word for an address. */
export function addressWord(address: string): string {
  if (!isAddress(address)) throw new Error(`invalid address: ${address}`);
  return strip0x(address).toLowerCase().padStart(64, "0");
}

function hexToUtf8(hexBytes: string): string {
  const bytes = new Uint8Array(Math.floor(hexBytes.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hexBytes.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

// Remove trailing NUL padding (bytes32 fields are right-padded with zeros).
function trimNulls(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end--;
  return s.slice(0, end);
}

/**
 * Text from a contract (a token's name, a revert message) is controlled by whoever wrote the contract. Control
 * characters are dropped so it cannot inject terminal escape sequences into a CLI or break a page's layout, and
 * the length is capped. Dropped: C0 controls (0x00-0x1F), DEL (0x7F) and C1 controls (0x80-0x9F).
 */
export function sanitizeText(s: string, max = 80): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    out += ch;
  }
  out = out.trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * Decodes name()/symbol() whether they return the ABI `string` encoding or the non-standard fixed bytes32 that
 * some real tokens return. Returns null when nothing readable came back.
 */
export function decodeStringOrBytes32(hex: string): string | null {
  const clean = strip0x(hex);
  if (clean.length === 0) return null;

  // Exactly 32 bytes => treat as bytes32: strip NUL padding, decode as UTF-8.
  if (clean.length === 64) {
    const s = sanitizeText(trimNulls(hexToUtf8(clean)));
    return s.length > 0 ? s : null;
  }

  // Dynamic string: [offset][length][data...]
  if (clean.length >= 128) {
    const offset = Number(decodeUint(clean.slice(0, 64)));
    if (!Number.isSafeInteger(offset)) return null;
    const lenStart = offset * 2;
    if (lenStart + 64 > clean.length) return null;
    const len = Number(decodeUint(clean.slice(lenStart, lenStart + 64)));
    if (!Number.isSafeInteger(len)) return null;
    const dataStart = lenStart + 64;
    const dataHex = clean.slice(dataStart, dataStart + Math.min(len, 4096) * 2);
    const s = sanitizeText(trimNulls(hexToUtf8(dataHex)));
    return s.length > 0 ? s : null;
  }

  return null;
}
