import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findViolations } from "../src/guard";

const { exact, contains } = JSON.parse(readFileSync(new URL("../test-vectors/guard-cases.json", import.meta.url), "utf-8")) as {
  exact: [string, string[]][];
  contains: [string, string][];
};

describe("the copy rules, same cases as the engine's table", () => {
  it.each(exact)("%j", (text, rules) => {
    expect(findViolations(text)).toEqual(rules);
  });

  it.each(contains)("%j breaks %s", (text, rule) => {
    expect(findViolations(text)).toContain(rule);
  });
});
