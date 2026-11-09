import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeAddress,
  decodeBool,
  decodeStringOrBytes32,
  decodeUint,
  decodeUint8,
  isAddress,
  sanitizeText,
  shortenAddress,
  toChecksumAddress,
} from "../src/chain/abi";

// 32-byte word helper.
const word = (hex: string) => `0x${hex.padStart(64, "0")}`;
const asciiHex = (s: string) => Buffer.from(s).toString("hex");

function hasControlChars(s: string): boolean {
  return [...s].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || (c >= 0x7f && c <= 0x9f);
  });
}

describe("abi helpers", () => {
  it("decodeUint parses a 32-byte word", () => {
    expect(decodeUint(word("0"))).toBe(0n);
    expect(decodeUint(word("12"))).toBe(18n);
    expect(decodeUint(`0x${"f".repeat(64)}`)).toBe((1n << 256n) - 1n);
    expect(decodeUint("0x1237")).toBe(4663n);
  });

  it("decodeUint8 reads decimals", () => {
    expect(decodeUint8(word("12"))).toBe(18);
    expect(decodeUint8(word("06"))).toBe(6);
  });

  it("decodeAddress takes the last 20 bytes, checksummed", () => {
    expect(decodeAddress("0x000000000000000000000000abcdef0000000000000000000000000000001234")).toBe(
      getAddress("0xabcdef0000000000000000000000000000001234"),
    );
  });

  it("decodeBool", () => {
    expect(decodeBool(word("0"))).toBe(false);
    expect(decodeBool(word("1"))).toBe(true);
  });

  it("toChecksumAddress agrees with viem's getAddress", () => {
    for (const a of [
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
      "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      "0x000000000000000000000000000000000000dead",
      `0x${"ff".repeat(20)}`,
    ]) {
      expect(toChecksumAddress(a)).toBe(getAddress(a));
    }
  });

  it("decodeStringOrBytes32 decodes a dynamic string", () => {
    const dynamic = `0x${"20".padStart(64, "0")}${"7".padStart(64, "0")}${asciiHex("CashCat").padEnd(64, "0")}`;
    expect(decodeStringOrBytes32(dynamic)).toBe("CashCat");
  });

  it("decodeStringOrBytes32 decodes a non-standard bytes32 symbol", () => {
    expect(decodeStringOrBytes32(`0x${asciiHex("CASH").padEnd(64, "0")}`)).toBe("CASH");
  });

  it("decodeStringOrBytes32 returns null for nothing", () => {
    expect(decodeStringOrBytes32("0x")).toBeNull();
    expect(decodeStringOrBytes32(word("0"))).toBeNull();
  });

  it("decodeStringOrBytes32 strips control characters (terminal-injection guard)", () => {
    const evil = `${asciiHex("CASH")}1b5b324a`; // CASH + ESC[2J
    const decoded = decodeStringOrBytes32(`0x${evil.padEnd(64, "0")}`) ?? "";
    expect(hasControlChars(decoded)).toBe(false);
    expect(decoded.startsWith("CASH")).toBe(true);
  });

  it("decodeStringOrBytes32 caps absurdly long names", () => {
    const long = asciiHex("A".repeat(200));
    const dynamic = `0x${(32).toString(16).padStart(64, "0")}${(200).toString(16).padStart(64, "0")}${long.padEnd(
      Math.ceil(long.length / 64) * 64,
      "0",
    )}`;
    expect((decodeStringOrBytes32(dynamic) ?? "").length).toBeLessThanOrEqual(81);
  });

  it("decodeStringOrBytes32 survives a hostile offset or length", () => {
    expect(decodeStringOrBytes32(`0x${"f".repeat(64)}${"0".repeat(64)}`)).toBeNull();
    expect(decodeStringOrBytes32(`0x${"20".padStart(64, "0")}${"f".repeat(64)}`)).toBeNull();
  });

  it("sanitizeText drops C0 and C1 controls", () => {
    expect(sanitizeText("a\u0007b\u009bc\u007fd")).toBe("abcd");
  });

  it("isAddress validates the format", () => {
    expect(isAddress(`0x${"1".repeat(40)}`)).toBe(true);
    expect(isAddress("0xtest")).toBe(false);
    expect(isAddress(`0x${"1".repeat(39)}`)).toBe(false);
  });

  it("shortenAddress formats a checksummed address for evidence", () => {
    expect(shortenAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73")).toBe("0x0Bd7…AD73");
  });
});
