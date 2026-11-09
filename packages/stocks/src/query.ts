/** What someone typed into the stock search: a ticker, a contract address, or neither. */
import { getAddress, isAddress, type Address } from "viem";

export type StockQuery =
  | { kind: "empty" }
  | { kind: "address"; address: Address }
  | { kind: "ticker"; ticker: string }
  | { kind: "invalid"; reason: string };

/** Letters first, then letters, digits, dots, dashes or underscores: the factory has deployed "PEACH_DEFI_1". */
const TICKER = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/;

export function parseQuery(input: string): StockQuery {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  if (/^0x/i.test(text)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return { kind: "invalid", reason: "An address is 0x followed by 40 hexadecimal characters." };
    // Mixed case carries an EIP-55 checksum, which catches a mistyped character.
    const mixed = text.slice(2) !== text.slice(2).toLowerCase() && text.slice(2) !== text.slice(2).toUpperCase();
    if (mixed && !isAddress(text, { strict: true })) return { kind: "invalid", reason: "This address's capital letters do not match its checksum: a character may be mistyped." };
    return { kind: "address", address: getAddress(text.toLowerCase()) };
  }
  if (!TICKER.test(text)) return { kind: "invalid", reason: "A ticker is a few letters, such as NVDA, or paste a contract address." };
  return { kind: "ticker", ticker: text.toUpperCase() };
}
