import { describe, expect, it } from "vitest";
import { formatAmount, formatBps, formatDuration, formatPercent, formatUtc, phaseExplained, phaseLabel, progress, shortAddress } from "../src/facts";

describe("derived facts", () => {
  it("measures progress towards graduation from the curve's own numbers", () => {
    expect(progress(2_100_000_000_000_000_000n, 4_200_000_000_000_000_000n)).toBe(0.5);
    expect(progress(916_940_726n, 8_090_000_000n)).toBeCloseTo(0.1133, 4);
    expect(progress(5n, 4n)).toBe(1);
    expect(progress(null, 4n)).toBeNull();
    expect(progress(1n, 0n)).toBeNull();
  });

  it("writes basis points as percentages", () => {
    expect(formatBps(100)).toBe("1%");
    expect(formatBps(50)).toBe("0.5%");
    expect(formatBps(0)).toBe("0%");
    expect(formatBps(1000)).toBe("10%");
    expect(formatBps(125)).toBe("1.25%");
  });

  it("writes fractions as percentages without false precision at the ends", () => {
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(0.0113)).toBe("1.1%");
    expect(formatPercent(0.0001)).toBe("<0.1%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.9999)).toBe(">99.9%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("writes amounts in their own decimals with four significant digits", () => {
    expect(formatAmount(46_613_422_498_278_777n, 18)).toBe("0.04661");
    expect(formatAmount(916_940_726n, 6)).toBe("916.9");
    expect(formatAmount(8_090_000_000n, 6)).toBe("8,090");
    expect(formatAmount(26_639_006_882_017_848_277n, 18)).toBe("26.64");
    expect(formatAmount(12_400n * 10n ** 18n, 18)).toBe("12,400");
    expect(formatAmount(10n ** 27n, 18)).toBe("1B");
    expect(formatAmount(285_714_285_714_285_714_285_714_285n, 18)).toBe("286M");
    expect(formatAmount(0n, 18)).toBe("0");
    expect(formatAmount(1n, 18)).toBe("<0.000001");
  });

  it("writes durations and times the same everywhere", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(5 * 60 + 3)).toBe("5 min");
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe("3 h 20 min");
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2 d 4 h");
    expect(formatUtc(1_794_207_706)).toBe("9 Nov 2026, 07:01 UTC");
  });

  it("names phases plainly", () => {
    expect(phaseLabel("curve", false)).toBe("On its curve");
    expect(phaseLabel("graduated", true)).toBe("Graduated");
    expect(phaseLabel(null, true)).toBe("Graduated");
    expect(phaseLabel(null, null)).toBe("Unknown");
    expect(phaseExplained("graduated")).toMatch(/Uniswap V4 pool/);
  });

  it("shortens addresses", () => {
    expect(shortAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e")).toBe("0x7eD5…EC7e");
  });
});
