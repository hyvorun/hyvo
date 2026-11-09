import { describe, expect, it } from "vitest";
import { formatSpan, formatUtc, formatUtcDay, relativeTime, shortName } from "../src/format";
import { measuredLine } from "../src/index";

describe("words and times", () => {
  it("writes times in UTC", () => {
    expect(formatUtc(1_794_207_857)).toBe("9 Nov 2026, 07:04 UTC");
    expect(formatUtcDay(1_788_998_430)).toBe("10 Sept 2026");
  });

  it("says how far a time is from now", () => {
    expect(relativeTime(1000, 1020)).toBe("just now");
    expect(relativeTime(1000, 1000 + 1429)).toBe("24 min ago");
    expect(relativeTime(1000 + 3600, 1000)).toBe("in 60 min");
    expect(relativeTime(0, 5 * 3600)).toBe("5 h ago");
    expect(relativeTime(0, 3 * 86_400)).toBe("3 days ago");
  });

  it("writes a heartbeat as a span", () => {
    expect(formatSpan(86_400)).toBe("24 h");
    expect(formatSpan(3 * 86_400)).toBe("3 days");
    expect(formatSpan(1800)).toBe("30 min");
    expect(formatSpan(45)).toBe("45 s");
  });

  it("drops the suffix every token's name carries", () => {
    expect(shortName("NVIDIA • Robinhood Token")).toBe("NVIDIA");
    expect(shortName("Roundhill Weekly T-Bill ETF")).toBe("Roundhill Weekly T-Bill ETF");
  });

  it("ends every page of facts the same way", () => {
    expect(measuredLine(109_864_570n)).toBe("Measured on-chain at block 109,864,570. Not a trading signal.");
  });
});
