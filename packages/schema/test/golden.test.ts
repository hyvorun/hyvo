import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashRun, RunV1, verifyRunHash } from "../src/index";

const GOLDEN_HASH = "0x3f59118078569faaba4769e7da6246c816fc9f9d6bbcf22581a98e0ae63a570d";
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/golden-run.json", import.meta.url)), "utf8"),
);

describe("the golden run (fixtures/golden-run.json)", () => {
  it("is a valid RunV1", () => {
    expect(RunV1.safeParse(golden).error?.issues).toBeUndefined();
  });

  it("hashes to the same value as on the Python side", () => {
    expect(hashRun(golden)).toBe(GOLDEN_HASH);
    expect(verifyRunHash(golden)).toEqual({ ok: true, expected: GOLDEN_HASH, actual: GOLDEN_HASH });
  });
});
