import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { indicatorBox, springAt, springEasing, springOvershoot } from "../src/components/motion/spring";

const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function token(name: string): string {
  const match = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`${name} is not in tokens.css`);
  return match[1]!.trim();
}

function stops(easing: string): number[] {
  return easing
    .replace(/^linear\(|\)$/g, "")
    .split(",")
    .map((value) => Number(value.trim()));
}

describe("springAt", () => {
  it("starts at rest and ends exactly on the target", () => {
    expect(springAt(0, 0.72)).toBe(0);
    expect(springAt(1, 0.72)).toBe(1);
    expect(springAt(-1, 0.72)).toBe(0);
    expect(springAt(2, 0.72)).toBe(1);
  });

  it("rises steadily to its peak, which is the overshoot the damping predicts", () => {
    for (const damping of [0.58, 0.72]) {
      const samples = Array.from({ length: 401 }, (_, i) => springAt(i / 400, damping));
      const peakAt = samples.indexOf(Math.max(...samples));
      for (let i = 1; i <= peakAt; i++) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
      expect(samples[peakAt]! - 1).toBeCloseTo(springOvershoot(damping), 2);
    }
  });

  it("has settled to within 0.3% of the target by the end", () => {
    for (const damping of [0.58, 0.72]) {
      for (let t = 0.9; t < 1; t += 0.01) expect(Math.abs(springAt(t, damping) - 1)).toBeLessThan(0.003);
    }
  });
});

describe("springOvershoot", () => {
  it("keeps the release spring small and the pop spring visible but modest", () => {
    expect(springOvershoot(0.72)).toBeGreaterThan(0.03);
    expect(springOvershoot(0.72)).toBeLessThan(0.05);
    expect(springOvershoot(0.58)).toBeGreaterThan(0.08);
    expect(springOvershoot(0.58)).toBeLessThan(0.13);
  });
});

describe("springEasing", () => {
  it("writes a linear() easing from 0 to 1", () => {
    const values = stops(springEasing(0.72));
    expect(values).toHaveLength(29);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
    expect(Math.max(...values)).toBeLessThan(1.05);
  });

  it("matches the spring tokens in tokens.css", () => {
    expect(token("--ease-spring")).toBe(springEasing(0.72));
    expect(token("--ease-spring-pop")).toBe(springEasing(0.58));
  });
});

describe("motion tokens", () => {
  it("keeps hover, press and entrance durations in their ranges", () => {
    const ms = (name: string) => Number(token(name).replace("ms", ""));
    expect(ms("--dur-hover")).toBeGreaterThanOrEqual(150);
    expect(ms("--dur-hover")).toBeLessThanOrEqual(200);
    expect(ms("--dur-press")).toBeGreaterThanOrEqual(90);
    expect(ms("--dur-press")).toBeLessThanOrEqual(120);
    expect(ms("--dur-enter")).toBeGreaterThanOrEqual(450);
    expect(ms("--dur-enter-long")).toBeLessThanOrEqual(800);
    expect(ms("--stagger")).toBeGreaterThanOrEqual(40);
    expect(ms("--stagger")).toBeLessThanOrEqual(70);
  });
});

describe("indicatorBox", () => {
  it("spans the link's text, inside its padding", () => {
    expect(indicatorBox(120, 60, 10)).toEqual({ x: 130, width: 40 });
  });

  it("spans the whole link when the padding would leave nothing", () => {
    expect(indicatorBox(8, 16, 10)).toEqual({ x: 8, width: 16 });
  });

  it("rounds to hundredths of a pixel", () => {
    expect(indicatorBox(10.123, 50.456, 6)).toEqual({ x: 16.12, width: 38.46 });
  });
});
