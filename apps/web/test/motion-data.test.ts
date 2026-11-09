import { describe, expect, it } from "vitest";
import { clamp01, countAt, countDuration, easeOutCubic, easeOutQuart } from "../src/lib/motion/count";
import { rollDirection, rollKeys } from "../src/lib/motion/roll";
import { canScramble, scrambleAt } from "../src/lib/motion/scramble";

describe("easing", () => {
  it("starts at 0, ends at 1 and never leaves that range", () => {
    for (const ease of [easeOutQuart, easeOutCubic]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(-1)).toBe(0);
      expect(ease(2)).toBe(1);
      expect(ease(Number.NaN)).toBe(0);
    }
  });

  it("is an ease-out: past half way at half time, and never going back", () => {
    expect(easeOutQuart(0.5)).toBeGreaterThan(0.9);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.85);
    let previous = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      const now = easeOutQuart(t);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it("clamps", () => {
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(7)).toBe(1);
  });
});

describe("countAt", () => {
  it("runs from the start to the end value", () => {
    expect(countAt(0, 500, 0, 900)).toBe(0);
    expect(countAt(0, 500, 900, 900)).toBe(500);
    expect(countAt(0, 500, 5000, 900)).toBe(500);
  });

  it("keeps a count of whole things whole", () => {
    for (let ms = 0; ms <= 900; ms += 37) expect(Number.isInteger(countAt(0, 1234, ms, 900))).toBe(true);
  });

  it("lets a fractional value pass through fractions", () => {
    expect(Number.isInteger(countAt(0, 12.5, 100, 900))).toBe(false);
  });

  it("counts down as well as up", () => {
    const halfway = countAt(100, 0, 450, 900);
    expect(halfway).toBeLessThan(100);
    expect(halfway).toBeGreaterThanOrEqual(0);
  });

  it("jumps to the end for no duration or a value that is not a number", () => {
    expect(countAt(0, 10, 0, 0)).toBe(10);
    expect(countAt(Number.NaN, 10, 10, 900)).toBe(10);
  });
});

describe("countDuration", () => {
  it("is the base for an ordinary number and shorter for a tiny count", () => {
    expect(countDuration(0, 500)).toBe(900);
    expect(countDuration(0, 12.5)).toBe(900);
    expect(countDuration(0, 3)).toBeLessThan(900);
    expect(countDuration(0, 1)).toBeGreaterThanOrEqual(360);
    expect(countDuration(4, 4)).toBe(0);
  });
});

describe("scrambleAt", () => {
  const hash = "0x1c91e60e…f5a1";
  const fixed = () => 0.37;

  it("is the text itself at the end", () => {
    expect(scrambleAt(hash, 1, fixed)).toBe(hash);
    expect(scrambleAt(hash, 1.4, fixed)).toBe(hash);
  });

  it("keeps its length and its separators from the first frame", () => {
    const start = scrambleAt(hash, 0, fixed);
    expect(start).toHaveLength(hash.length);
    expect(start[1]).toBe("x");
    expect(start).toContain("…");
  });

  it("resolves left to right, and an unresolved character is never the final one", () => {
    const mid = scrambleAt(hash, 0.5, fixed);
    const front = Math.ceil(hash.length * 0.5);
    expect(mid.slice(0, front)).toBe(hash.slice(0, front));
    for (let i = front; i < hash.length; i++) {
      if (/[0-9a-f]/.test(hash[i]!)) expect(mid[i]).not.toBe(hash[i]);
    }
  });

  it("scrambles hex as hex, in the case it is written in", () => {
    const upper = scrambleAt("ABCDEF", 0, () => 0.99);
    expect(upper).toMatch(/^[0-9A-F]{6}$/);
    const lower = scrambleAt("abcdef", 0, () => 0.5);
    expect(lower).toMatch(/^[0-9a-f]{6}$/);
  });

  it("only decodes what has enough to decode", () => {
    expect(canScramble(hash)).toBe(true);
    expect(canScramble("–")).toBe(false);
    expect(canScramble("0x1")).toBe(false);
  });
});

describe("rollKeys", () => {
  it("changes only the key of the digit that changed", () => {
    const before = rollKeys("1,204").map((k) => k.key);
    const after = rollKeys("1,205").map((k) => k.key);
    expect(after.filter((key) => !before.includes(key))).toEqual(["1:5"]);
  });

  it("keys places from the right, so a longer number keeps its ones and tens", () => {
    const before = rollKeys("998").map((k) => k.key);
    const after = rollKeys("1,008").map((k) => k.key);
    expect(after).toContain("1:8");
    expect(before).toContain("1:8");
  });

  it("knows which way a change goes", () => {
    expect(rollDirection(null, 4)).toBe("none");
    expect(rollDirection(3, 4)).toBe("up");
    expect(rollDirection(4, 3)).toBe("down");
    expect(rollDirection(4, 4)).toBe("none");
  });
});
