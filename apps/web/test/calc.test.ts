import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatShare,
  fromBaseUnits,
  groupDigits,
  impermanentLoss,
  parseAmount,
  positionValues,
  quote,
  roundTrip,
  toBaseUnits,
} from "../src/lib/calc";
import { amountOut } from "../src/lib/replay";

const pool = { eth: 10, tokens: 1_000_000 };

describe("quote", () => {
  it("matches the integer swap the fork's test pools use", () => {
    const q = quote(pool, 1, "eth-in", 1)!;
    // amountOut in lib/replay.ts works on base units with the fee in basis points.
    const exact = amountOut(10n ** 18n, 10n * 10n ** 18n, 1_000_000n * 10n ** 18n, 100);
    expect(q.amountOut).toBeCloseTo(Number(exact) / 1e18, 6);
  });

  it("keeps the product of the reserves from shrinking, and takes the fee from what goes in", () => {
    const q = quote(pool, 1, "eth-in", 2)!;
    expect(q.fee).toBeCloseTo(0.02, 12);
    expect(q.after.eth).toBe(12);
    expect(q.after.eth * q.after.tokens).toBeGreaterThan(pool.eth * pool.tokens);
    // Without a fee the product stays exactly the same.
    const free = quote(pool, 0, "eth-in", 2)!;
    expect(free.after.eth * free.after.tokens).toBeCloseTo(pool.eth * pool.tokens, 3);
  });

  it("moves the price up when ETH goes in and down when tokens go in", () => {
    const up = quote(pool, 1, "eth-in", 1)!;
    expect(up.priceBefore).toBeCloseTo(0.00001, 15);
    expect(up.priceMove).toBeGreaterThan(0);
    expect(up.costVsSpot).toBeGreaterThan(0);
    const down = quote(pool, 1, "tokens-in", 100_000)!;
    expect(down.priceMove).toBeLessThan(0);
    expect(down.costVsSpot).toBeGreaterThan(0);
    expect(down.averagePrice).toBeLessThan(down.priceBefore);
  });

  it("costs almost only the fee for a tiny trade", () => {
    const q = quote(pool, 1, "eth-in", 0.000001)!;
    expect(q.costVsSpot).toBeCloseTo(1 / 0.99 - 1, 5);
  });

  it.each([
    [{ eth: 0, tokens: 1 }, 1, 1],
    [pool, -1, 1],
    [pool, 100, 1],
    [pool, 1, 0],
    [pool, 1, Number.NaN],
    [pool, 1, Number.POSITIVE_INFINITY],
  ])("refuses %o, fee %d, amount %d", (state, fee, amount) => {
    expect(quote(state, fee, "eth-in", amount)).toBeNull();
  });
});

describe("roundTrip", () => {
  it("loses about two fees on a tiny trade", () => {
    expect(roundTrip(pool, 5, 0.000001)!.loss).toBeCloseTo(1 - 0.95 * 0.95, 4);
  });

  it("loses nothing without a fee", () => {
    expect(roundTrip(pool, 0, 3)!.loss).toBeCloseTo(0, 10);
  });
});

describe("impermanent loss", () => {
  it.each([
    [1, 0],
    [2, -0.05719],
    [4, -0.2],
    [0.5, -0.05719],
    [0.25, -0.2],
  ])("price times %d", (ratio, expected) => {
    expect(impermanentLoss(ratio)!).toBeCloseTo(expected, 4);
  });

  it("values the position against holding", () => {
    const values = positionValues(10, 4)!;
    expect(values.held).toBe(25);
    expect(values.pooled).toBe(20);
    expect(values.pooled / values.held - 1).toBeCloseTo(impermanentLoss(4)!, 12);
  });

  it("refuses a price that falls to zero or below", () => {
    expect(impermanentLoss(0)).toBeNull();
    expect(positionValues(10, -1)).toBeNull();
  });
});

describe("parseAmount", () => {
  it.each([
    ["1,000,000", 1_000_000],
    ["0.5", 0.5],
    [".25", 0.25],
    ["1e9", 1e9],
    ["2.5m", 2_500_000],
    ["1B", 1e9],
    ["10k", 10_000],
    [" 1_000 ", 1000],
  ])("reads %s", (text, value) => {
    expect(parseAmount(text)).toBe(value);
  });

  it("keeps a sign only when asked", () => {
    expect(parseAmount("-50", true)).toBe(-50);
    expect(parseAmount("−50", true)).toBe(-50);
    expect(parseAmount("+100", true)).toBe(100);
    expect(parseAmount("-50")).toBeNaN();
  });

  it.each(["", "abc", "1.2.3", "1x", "--1"])("refuses %j", (text) => {
    expect(parseAmount(text, true)).toBeNaN();
  });
});

describe("base units", () => {
  it("converts exactly in both directions", () => {
    expect(toBaseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(toBaseUnits("0.000000001", 18)).toBe(1_000_000_000n);
    expect(toBaseUnits("1,000", 6)).toBe(1_000_000_000n);
    expect(toBaseUnits("7", 0)).toBe(7n);
    expect(fromBaseUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(fromBaseUnits(1n, 18)).toBe("0.000000000000000001");
    expect(fromBaseUnits(123n, 0)).toBe("123");
    expect(fromBaseUnits(-25n, 1)).toBe("-2.5");
  });

  it("refuses text that is not a plain decimal, or has more places than the unit", () => {
    expect(toBaseUnits("1.5", 0)).toBeNull();
    expect(toBaseUnits("1e18", 18)).toBeNull();
    expect(toBaseUnits("", 18)).toBeNull();
    expect(toBaseUnits(".", 18)).toBeNull();
    expect(toBaseUnits("-1", 18)).toBeNull();
  });

  it("groups digits of the whole part only", () => {
    expect(groupDigits("1234567.123456")).toBe("1,234,567.123456");
    expect(groupDigits("999")).toBe("999");
  });
});

describe("formatting", () => {
  it("formats amounts for reading", () => {
    expect(formatAmount(1234567.891)).toBe("1,234,570");
    expect(formatAmount(0.000012345678)).toBe("0.0000123457");
    expect(formatAmount(1e-12)).toBe("1.000e-12");
    expect(formatAmount(0)).toBe("0");
    expect(formatAmount(-0.857864)).toBe("−0.857864");
    expect(formatAmount(Number.NaN)).toBe("–");
  });

  it("formats shares as percentages", () => {
    expect(formatShare(0.05719)).toBe("5.72%");
    expect(formatShare(0.05719, true)).toBe("+5.72%");
    expect(formatShare(-0.2, true)).toBe("−20.0%");
    expect(formatShare(-0.2)).toBe("−20.0%");
    expect(formatShare(2)).toBe("200%");
    expect(formatShare(0)).toBe("0%");
  });
});
