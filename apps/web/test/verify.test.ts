import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RunV1, scenarioHash } from "@hyvo/schema";
import { describe, expect, it } from "vitest";
import { compare, resolveOracle } from "../src/lib/verify";

const golden = RunV1.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/golden-run.json", import.meta.url)), "utf8")),
);
const commit = { reportHash: golden.hash as `0x${string}`, scenarioHash: scenarioHash(golden.scenario), committedAt: 1n };

describe("resolveOracle", () => {
  const ours = "0x00000000000000000000000000000000000dd003";
  const other = "0x00000000000000000000000000000000000dd004";

  it("prefers the address the app was built with", () => {
    expect(resolveOracle(ours, ours.toUpperCase().replace("0X", "0x"))).toEqual({ address: ours, pinned: true, conflict: null });
    expect(resolveOracle(ours, other)).toEqual({ address: ours, pinned: true, conflict: other });
    expect(resolveOracle(ours, null)).toEqual({ address: ours, pinned: true, conflict: null });
  });

  it("falls back to the API's address and says so", () => {
    expect(resolveOracle("", other)).toEqual({ address: other, pinned: false, conflict: null });
    expect(resolveOracle("", null)).toEqual({ address: null, pinned: false, conflict: null });
  });
});

describe("compare", () => {
  it("passes when the chain holds the run hash and the scenario hash", () => {
    const result = compare(golden, commit);
    expect(result.ok).toBe(true);
    expect(result.runHash).toBe(golden.hash);
    expect(result.steps.map((step) => step.ok)).toEqual([true, true, true]);
  });

  it("fails without a commit", () => {
    const result = compare(golden, null);
    expect(result.ok).toBe(false);
    expect(result.steps[1]!.detail).toBe("no commit for this run id");
  });

  it("fails when either hash differs, and accepts upper-case hex from the chain", () => {
    expect(compare(golden, { ...commit, reportHash: `0x${"11".repeat(32)}` }).ok).toBe(false);
    expect(compare(golden, { ...commit, scenarioHash: `0x${"22".repeat(32)}` }).ok).toBe(false);
    const upper = { ...commit, reportHash: golden.hash.toUpperCase().replace("0X", "0x") as `0x${string}` };
    expect(compare(golden, upper).ok).toBe(true);
  });

  it("fails a run.json whose content does not match its hash", () => {
    const edited = { ...golden, report: { ...golden.report, summary: `${golden.report.summary} (edited)` } };
    const result = compare(edited, commit);
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.ok).toBe(false);
  });
});
