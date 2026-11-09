import { describe, expect, it } from "vitest";
import { formatAmount, formatEth, formatPct, formatUnits, parseEth, shortfallPct } from "../src/chain/units";

describe("units", () => {
  it("formatUnits is exact", () => {
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(10n ** 18n, 18)).toBe("1");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(-25n, 1)).toBe("-2.5");
    expect(formatUnits(42n, 0)).toBe("42");
  });

  it("formatAmount groups thousands and cuts without rounding up", () => {
    expect(formatAmount(581054078393318008147934n, 18)).toBe("581,054.07");
    expect(formatAmount(2130313n, 6)).toBe("2.1303");
    expect(formatAmount(961234567890000n, 18)).toBe("0.000961234");
    expect(formatAmount(961234967890000n, 18)).toBe("0.000961234");
    expect(formatAmount(0n, 18)).toBe("0");
    expect(formatAmount(1234567n * 10n ** 18n, 18)).toBe("1,234,567");
  });

  it("formatEth and parseEth", () => {
    expect(formatEth(10n ** 15n)).toBe("0.001 ETH");
    expect(parseEth("0.001")).toBe(10n ** 15n);
    expect(parseEth("1 ether")).toBe(10n ** 18n);
    expect(parseEth("0.5eth")).toBe(5n * 10n ** 17n);
    expect(() => parseEth("abc")).toThrow();
    expect(() => parseEth("0.0000000000000000001")).toThrow();
  });

  it("formatPct", () => {
    expect(formatPct(3.9512)).toBe("3.95%");
    expect(formatPct(0.6)).toBe("0.6%");
    expect(formatPct(5)).toBe("5%");
    expect(formatPct(0)).toBe("0%");
  });

  it("shortfallPct works in bigint", () => {
    expect(shortfallPct(1000n, 950n)).toBe(5);
    expect(shortfallPct(1000n, 1000n)).toBe(0);
    expect(shortfallPct(1000n, 1010n)).toBe(-1);
    expect(shortfallPct(3n, 2n)).toBe(33.3333);
  });
});
