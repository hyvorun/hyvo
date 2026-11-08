import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RunSummary, RunV1, SUMMARY_CHARS, clipCodePoints, summarizeRun } from "../src/index";

const golden = RunV1.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/golden-run.json", import.meta.url)), "utf8")),
);

describe("the summary vectors shared with the Python engine", () => {
  it.each([
    ["../../../fixtures/golden-run.json", "../test-vectors/golden-run.summary.json"],
    ["../test-vectors/sample-run.json", "../test-vectors/sample-run.summary.json"],
  ])("%s gives %s (pnpm gen refreshes it)", (source, vector) => {
    const read = (relative: string) => JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
    expect(summarizeRun(read(source))).toEqual(read(vector));
  });
});

describe("summarizeRun", () => {
  const derived = summarizeRun(golden);

  it("produces a RunSummary once the API adds publishedAt and featured", () => {
    const summary = { ...derived, publishedAt: "2026-11-03T12:00:00Z", featured: true };
    expect(RunSummary.safeParse(summary).error?.issues).toBeUndefined();
  });

  it("derives the market and counts from the run", () => {
    expect(derived.market.priceStart).toBe(golden.world.initialMarket.price);
    expect(derived.market.priceEnd).toBe(golden.rounds.at(-1)!.market.price);
    expect(derived.sparkline).toHaveLength(golden.rounds.length + 1);
    expect(derived.market.posts).toBe(golden.rounds.reduce((n, r) => n + r.posts.length, 0));
    const swaps = golden.rounds.flatMap((r) => r.actions).filter((a) => a.status === "ok" && a.kind.startsWith("swap_"));
    expect(derived.market.swaps).toBe(swaps.length);
    expect(derived.rounds).toBe(10);
    expect([...derived.summary].length).toBeLessThanOrEqual(SUMMARY_CHARS);
  });

  it("computes the price change from the start and end prices", () => {
    const start = Number(derived.market.priceStart);
    const end = Number(derived.market.priceEnd);
    expect(derived.market.priceChangePct).toBeCloseTo(((end - start) / start) * 100, 2);
  });
});

describe("clipCodePoints", () => {
  it("keeps short text and cuts long text with an ellipsis", () => {
    expect(clipCodePoints("short", 10)).toBe("short");
    expect(clipCodePoints("\u{1F680}".repeat(12), 10)).toBe(`${"\u{1F680}".repeat(9)}…`);
  });
});
