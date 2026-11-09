import { describe, expect, it } from "vitest";
import { divideToDecimal, formatFixed, groupThousands, roundDecimal } from "../src/decimal";
import { parseQuery } from "../src/query";

describe("parseQuery", () => {
  it("reads tickers in any case, and the factory's odd ones", () => {
    expect(parseQuery("  nvda ")).toEqual({ kind: "ticker", ticker: "NVDA" });
    expect(parseQuery("PEACH_DEFI_1")).toEqual({ kind: "ticker", ticker: "PEACH_DEFI_1" });
    expect(parseQuery("brk.b")).toEqual({ kind: "ticker", ticker: "BRK.B" });
    expect(parseQuery("")).toEqual({ kind: "empty" });
  });

  it("checks an address's checksum when it has one", () => {
    expect(parseQuery("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC")).toEqual({ kind: "address", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" });
    // All lower case carries no checksum, and comes back checksummed.
    expect(parseQuery("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec")).toEqual({ kind: "address", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" });
    expect(parseQuery("0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC").kind).toBe("invalid");
    expect(parseQuery("0x1234").kind).toBe("invalid");
  });

  it("refuses what is neither", () => {
    expect(parseQuery("$NVDA").kind).toBe("invalid");
    expect(parseQuery("nvidia corporation").kind).toBe("invalid");
  });
});

describe("exact decimals", () => {
  it("keeps every digit of a raw value", () => {
    expect(formatFixed(1000775159164630595n, 18)).toBe("1.000775159164630595");
    expect(formatFixed(17636673622n, 8)).toBe("176.36673622");
    expect(formatFixed(10n ** 18n, 18)).toBe("1");
  });

  it("divides and rounds half to even", () => {
    expect(divideToDecimal(1n, 3n, 4)).toBe("0.3333");
    expect(divideToDecimal(2n, 3n, 4)).toBe("0.6667");
    expect(divideToDecimal(1n, 8n, 2)).toBe("0.12");
    expect(divideToDecimal(3n, 8n, 2)).toBe("0.38");
    expect(divideToDecimal(4n * 10n ** 18n, 10n ** 18n, 6)).toBe("4");
    expect(() => divideToDecimal(1n, 0n, 2)).toThrow();
  });

  it("rounds a decimal string half to even and pads it", () => {
    expect(roundDecimal("176.36673622", 2)).toBe("176.37");
    expect(roundDecimal("0.125", 2)).toBe("0.12");
    expect(roundDecimal("0.135", 2)).toBe("0.14");
    expect(roundDecimal("0.1251", 2)).toBe("0.13");
    expect(roundDecimal("1", 2)).toBe("1.00");
    expect(roundDecimal("9.999", 2)).toBe("10.00");
  });

  it("groups thousands in the whole part only", () => {
    expect(groupThousands("1415.17492138")).toBe("1,415.17492138");
    expect(groupThousands("94544")).toBe("94,544");
    expect(groupThousands("12.5")).toBe("12.5");
  });
});
