import { describe, expect, it } from "vitest";
import { CHECK_ORDER, CHECKS } from "../src/checks/catalog";
import { hasBannedWords, quoteThirdParty } from "../src/output/copy";
import { makeFinding, validateFindings } from "../src/output/finding";
import type { Finding } from "../src/types";

describe("makeFinding", () => {
  it("rejects empty evidence", () => {
    expect(() => makeFinding({ id: "owner", status: "found", title: "t", evidence: "" })).toThrow(/no evidence/);
    expect(() => makeFinding({ id: "owner", status: "found", title: "t", evidence: "   " })).toThrow(/no evidence/);
  });

  it("rejects titles over 40 characters", () => {
    expect(() => makeFinding({ id: "owner", status: "found", title: "a".repeat(41), evidence: "e" })).toThrow(/exceeds 40/);
  });

  it("rejects an unknown status", () => {
    expect(() => makeFinding({ id: "owner", status: "ok" as never, title: "t", evidence: "e" })).toThrow(/unknown status/);
  });

  it("rejects words Hyvo never uses about a token", () => {
    for (const word of ["safe", "Scam", "rug pull", "honeypot", "legit", "guaranteed", "will pump", "good token", "bad token"]) {
      expect(() => makeFinding({ id: "owner", status: "found", title: "Owner", evidence: `this token is ${word}` }), word).toThrow(
        /copy rules/,
      );
    }
  });

  it("trims and keeps valid evidence", () => {
    expect(makeFinding({ id: "owner", status: "found", title: "Owner", evidence: "  owner() returns 0xabc  " }).evidence).toBe(
      "owner() returns 0xabc",
    );
  });
});

describe("validateFindings", () => {
  it("throws when a finding that skipped the factory has empty evidence", () => {
    const bad: Finding[] = [{ id: "owner", status: "found", title: "t", evidence: "" }];
    expect(() => validateFindings(bad)).toThrow(/empty evidence/);
  });

  it("throws when one carries a banned word", () => {
    const bad: Finding[] = [{ id: "owner", status: "found", title: "Owner", evidence: "looks legit" }];
    expect(() => validateFindings(bad)).toThrow(/copy rules/);
  });
});

describe("copy rules", () => {
  it("finds banned words as words, not inside identifiers or hex", () => {
    expect(hasBannedWords("a safe bet")).toBe(true);
    expect(hasBannedWords("SafeERC20: low-level call failed")).toBe(false);
    expect(hasBannedWords("0xdeadbeefcafe00bad1")).toBe(false);
    expect(hasBannedWords("unsafe")).toBe(false);
  });

  it("masks banned words in text a contract wrote, and drops control characters", () => {
    expect(quoteThirdParty("not a honeypot, totally safe")).toBe("not a […], totally […]");
    expect(quoteThirdParty("TransferHelper: TRANSFER_FROM_FAILED")).toBe("TransferHelper: TRANSFER_FROM_FAILED");
    expect(quoteThirdParty("a\u001b[2Jb")).toBe("a[2Jb");
    expect(quoteThirdParty("x".repeat(200)).length).toBeLessThanOrEqual(97);
  });

  it("keeps every check title short and free of banned words", () => {
    expect(CHECK_ORDER).toEqual(Object.keys(CHECKS));
    for (const id of CHECK_ORDER) {
      expect(CHECKS[id].title.length).toBeLessThanOrEqual(40);
      expect(hasBannedWords(CHECKS[id].title + CHECKS[id].looksFor)).toBe(false);
    }
  });
});
