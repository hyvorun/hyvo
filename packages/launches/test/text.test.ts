import { describe, expect, it } from "vitest";
import { cleanName, cleanSymbol, cleanText, distinctName } from "../src/text";

const char = (code: number) => String.fromCodePoint(code);

describe("on-chain names", () => {
  it("drops characters that hide or reorder text", () => {
    expect(cleanText(`SAFE${char(0x202e)}EKAF`, 64)).toBe("SAFEEKAF");
    expect(cleanText(`A${char(0x200b)}B${char(0xfeff)}C`, 64)).toBe("ABC");
    expect(cleanText(`x${char(0x2066)}y${char(0x2069)}`, 64)).toBe("xy");
    expect(cleanText(`tag${char(0xe0041)}`, 64)).toBe("tag");
  });

  it("turns line breaks and tabs into single spaces", () => {
    expect(cleanText("Two\nlines\tand\r\nmore", 64)).toBe("Two lines and more");
    expect(cleanText(`a${char(0x2028)}b`, 64)).toBe("a b");
  });

  it("keeps other scripts and emoji", () => {
    expect(cleanName("ポンちゃん")).toBe("ポンちゃん");
    expect(cleanSymbol("🐸FROG")).toBe("🐸FROG");
  });

  it("caps the length by characters, not code units", () => {
    expect(cleanText("🐸".repeat(30), 10)).toBe(`${"🐸".repeat(9)}…`);
    expect(Array.from(cleanSymbol("X".repeat(100)) ?? "").length).toBe(24);
  });

  it("limits stacked combining marks", () => {
    const zalgo = `a${char(0x0301).repeat(20)}`;
    expect(Array.from(cleanText(zalgo, 64) ?? "").length).toBeLessThanOrEqual(3);
  });

  it("returns null for nothing readable", () => {
    expect(cleanText("", 10)).toBeNull();
    expect(cleanText(`  ${char(0x200b)} `, 10)).toBeNull();
    expect(cleanText(42, 10)).toBeNull();
    expect(cleanText(null, 10)).toBeNull();
  });

  it("leaves out a name that only repeats the symbol", () => {
    expect(distinctName("TEXEL", "TEXEL")).toBeNull();
    expect(distinctName("$moo", "MOO")).toBeNull();
    expect(distinctName("Vice City Heat", "VCH")).toBe("Vice City Heat");
    expect(distinctName(null, "X")).toBeNull();
  });
});
