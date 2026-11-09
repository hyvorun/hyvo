// ERC-20 reads, built for the batched multicall. Tolerant by design: a non-standard token may not expose every
// field (no decimals, a bytes32 symbol, an empty name). Any single field that reverts or returns nothing
// becomes null; the check never crashes on it.

import { type Address, type TokenInfo } from "../types.js";
import { SELECTORS, addressWord, decodeStringOrBytes32, decodeUint, decodeUint8, strip0x } from "./abi.js";
import type { Read } from "./multicall.js";

export function balanceOfRead(token: string, holder: string): Read {
  return { target: token, data: SELECTORS.balanceOf + addressWord(holder) };
}

export function tokenReads(token: string): Read[] {
  return [
    { target: token, data: SELECTORS.name },
    { target: token, data: SELECTORS.symbol },
    { target: token, data: SELECTORS.decimals },
    { target: token, data: SELECTORS.totalSupply },
  ];
}

/** A uint256 answer, or null when there was none or it was not a full word. */
export function uintOrNull(raw: string | null): bigint | null {
  if (raw === null || strip0x(raw).length < 64) return null;
  return decodeUint(raw);
}

export function parseToken(address: Address, answers: readonly (string | null)[]): TokenInfo {
  const [name, symbol, decimals, totalSupply] = answers;
  const dec = uintOrNull(decimals ?? null);
  return {
    address,
    name: name ? decodeStringOrBytes32(name) : null,
    symbol: symbol ? decodeStringOrBytes32(symbol) : null,
    // A decimals() above 255 is not a uint8; treat it as no answer rather than wrap it.
    decimals: dec !== null && dec <= 255n ? decodeUint8(decimals!) : null,
    totalSupply: uintOrNull(totalSupply ?? null),
  };
}
