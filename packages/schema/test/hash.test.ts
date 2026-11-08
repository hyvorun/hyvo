import { describe, expect, it } from "vitest";
import {
  RunId,
  bytes32ToRunId,
  canonicalJson,
  hashRun,
  keccak256Utf8,
  runIdToBytes32,
  scenarioHash,
  verifyRunHash,
} from "../src/index";
import { canonicalCases, readPackageFile, sampleMeta, sampleRun, sampleRunText } from "./fixtures";

// RFC 8785 section 3.2.4: the UTF-8 bytes of the canonicalized section 3.2.2 sample.
const RFC8785_SAMPLE_UTF8 = `
  7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
  75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
  5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
  65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
  5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
  30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`;

const vector = (name: string) => {
  const found = canonicalCases.find((c) => c.name === name);
  if (!found) throw new Error(`missing vector ${name}`);
  return found;
};

describe("canonical vectors (test-vectors/canonical.json)", () => {
  it("has at least 25 uniquely named cases", () => {
    expect(canonicalCases.length).toBeGreaterThanOrEqual(25);
    expect(new Set(canonicalCases.map((c) => c.name)).size).toBe(canonicalCases.length);
  });

  it("is plain ASCII, so every reader decodes it the same way", () => {
    expect(readPackageFile("test-vectors/canonical.json")).toMatch(/^[\x00-\x7e]*$/);
  });

  it.each(canonicalCases)("$name", ({ inputJson, canonical, keccak256 }) => {
    expect(canonicalJson(JSON.parse(inputJson))).toBe(canonical);
    expect(keccak256Utf8(canonical)).toBe(keccak256);
  });
});

describe("RFC 8785 published examples", () => {
  it("section 3.2.4: UTF-8 bytes of the canonical sample", () => {
    const { canonical } = vector("rfc8785_section_3_2_2_example");
    expect(Buffer.from(canonical, "utf8").toString("hex")).toBe(RFC8785_SAMPLE_UTF8.replace(/\s+/g, ""));
  });

  it("section 3.2.3: property order sorted by UTF-16 code units", () => {
    const { canonical } = vector("rfc8785_sorting_example");
    const values = [...canonical.matchAll(/:"([^"]*)"/g)].map((match) => match[1]);
    expect(values).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
  });
});

describe("canonicalJson", () => {
  it("does not depend on key insertion order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });

  it.each([
    ["a lone high surrogate", "\ud800"],
    ["a lone low surrogate in a key", { "\udc00": 1 }],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a BigInt", 1n],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});

describe("keccak256Utf8", () => {
  it("is Ethereum Keccak-256, not NIST SHA3-256", () => {
    expect(keccak256Utf8("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Utf8("abc")).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });

  it("rejects a string with a lone surrogate (it has no UTF-8 encoding)", () => {
    expect(() => keccak256Utf8("a\ud83d")).toThrow(TypeError);
  });
});

describe("hashRun", () => {
  it("reproduces the sample hash", () => {
    const run = sampleRun();
    expect(run.hash).toBe(sampleMeta.hash);
    expect(hashRun(run)).toBe(sampleMeta.hash);
  });

  it("removes only the top-level hash member", () => {
    const { hash: _recorded, ...content } = sampleRun();
    expect(hashRun(content)).toBe(sampleMeta.hash);
    expect(hashRun({ ...content, hash: "anything" })).toBe(sampleMeta.hash);
    expect(hashRun({ a: 1, hash: "x" })).toBe(keccak256Utf8('{"a":1}'));
    expect(hashRun({ a: { hash: "x" } })).toBe(keccak256Utf8('{"a":{"hash":"x"}}'));
  });

  it("ignores formatting and key order of the file", () => {
    const compact = JSON.parse(JSON.stringify(sampleRun()));
    const reordered = Object.fromEntries(Object.entries(sampleRun()).reverse());
    expect(hashRun(compact)).toBe(sampleMeta.hash);
    expect(hashRun(reordered)).toBe(sampleMeta.hash);
    expect(hashRun(JSON.parse(sampleRunText.replace('"version": 1,', '"version":   1.0  ,')))).toBe(sampleMeta.hash);
  });

  it.each([
    ["a post", '"Fresh pool and thin', '"Fresh pool and thIn'],
    ["an emoji (U+1F680 -> U+1F681)", "\\ud83d\\ude80", "\\ud83d\\ude81"],
    ["an amount", '"amountIn": "0.5"', '"amountIn": "0.6"'],
    ["a like count", '"likes": 2', '"likes": 3'],
    ["the creation time", "12:00:00Z", "12:00:01Z"],
    ["a price", '"price": "0.000011446722520286"', '"price": "0.000011446722520287"'],
    ["the cost", '"costUsd": 0.000408', '"costUsd": 0.000409'],
  ])("changes when one character of %s changes", (_label, from, to) => {
    expect(sampleRunText).toContain(from);
    const tampered = JSON.parse(sampleRunText.replace(from, to));
    expect(hashRun(tampered)).not.toBe(sampleMeta.hash);
  });

  it("rejects a value that is not a JSON object", () => {
    for (const value of [null, [], "run", 1]) {
      expect(() => hashRun(value as never)).toThrow(TypeError);
    }
  });
});

describe("verifyRunHash", () => {
  it("accepts the sample", () => {
    expect(verifyRunHash(sampleRun())).toEqual({ ok: true, expected: sampleMeta.hash, actual: sampleMeta.hash });
  });

  it("reports a content change: expected is recomputed, actual is the recorded hash", () => {
    const run = sampleRun();
    run.report.summary = `${run.report.summary} `;
    const check = verifyRunHash(run);
    expect(check.ok).toBe(false);
    expect(check.actual).toBe(sampleMeta.hash);
    expect(check.expected).toBe(hashRun(run));
    expect(check.expected).not.toBe(sampleMeta.hash);
  });

  it("reports a wrong recorded hash", () => {
    const wrong = `0x${"0".repeat(64)}`;
    expect(verifyRunHash({ ...sampleRun(), hash: wrong })).toEqual({ ok: false, expected: sampleMeta.hash, actual: wrong });
  });

  it("compares hex exactly (the format is lowercase)", () => {
    const upper = `0x${sampleMeta.hash.slice(2).toUpperCase()}`;
    expect(verifyRunHash({ ...sampleRun(), hash: upper }).ok).toBe(false);
  });

  it("reports a missing or non-string hash as actual null", () => {
    const { hash: _recorded, ...content } = sampleRun();
    expect(verifyRunHash(content)).toEqual({ ok: false, expected: sampleMeta.hash, actual: null });
    expect(verifyRunHash({ ...content, hash: 42 }).actual).toBeNull();
  });
});

describe("scenarioHash", () => {
  it("reproduces the sample scenario hash", () => {
    expect(scenarioHash(sampleRun().scenario)).toBe(sampleMeta.scenarioHash);
  });

  it("changes when an injected event changes", () => {
    const { scenario } = sampleRun();
    scenario.injectedEvents[0]!.round = 1;
    expect(scenarioHash(scenario)).not.toBe(sampleMeta.scenarioHash);
  });
});

describe("runIdToBytes32 and bytes32ToRunId", () => {
  // Expected values computed independently with python-ulid: "0x" + "00" * 16 + ULID.bytes.hex().
  const fixed: [runId: string, bytes32: string][] = [
    ["run_00000000000000000000000000", `0x${"0".repeat(64)}`],
    ["run_0000000000000000000000000Z", `0x${"0".repeat(62)}1f`],
    ["run_00000000000000000000000010", `0x${"0".repeat(62)}20`],
    ["run_7ZZZZZZZZZZZZZZZZZZZZZZZZZ", `0x${"0".repeat(32)}${"f".repeat(32)}`],
    ["run_01JC8Z6Q3W1Y2V9K7T5R4N3M2P", "0x00000000000000000000000000000000019311f35c7c0f85b4ccfa2e0951d056"],
  ];

  it.each(fixed)("%s <-> %s", (runId, bytes32) => {
    expect(runIdToBytes32(runId)).toBe(bytes32);
    expect(bytes32ToRunId(bytes32)).toBe(runId);
  });

  it("reproduces the sample runIdBytes32", () => {
    expect(runIdToBytes32(sampleRun().runId)).toBe(sampleMeta.runIdBytes32);
    expect(bytes32ToRunId(sampleMeta.runIdBytes32)).toBe(sampleRun().runId);
  });

  it("round-trips any 128-bit value", () => {
    for (let i = 0; i < 200; i++) {
      const low = keccak256Utf8(`round-trip-${i}`).slice(2, 34);
      const bytes32 = `0x${"0".repeat(32)}${low}`;
      const runId = bytes32ToRunId(bytes32);
      expect(RunId.safeParse(runId).success).toBe(true);
      expect(runIdToBytes32(runId)).toBe(bytes32);
    }
  });

  it("accepts upper-case hex digits", () => {
    expect(bytes32ToRunId(`0x${sampleMeta.runIdBytes32.slice(2).toUpperCase()}`)).toBe(sampleRun().runId);
  });

  it.each([
    "run_01jc8z6q3w1y2v9k7t5r4n3m2p",
    "run_8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    "run_01JC8Z6Q3W1Y2V9K7T5R4N3MIL",
    "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2",
    "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2PP",
    "01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
    "",
  ])("runIdToBytes32 rejects %j", (runId) => {
    expect(() => runIdToBytes32(runId)).toThrow(TypeError);
  });

  it.each([
    `0x${"0".repeat(63)}`,
    `0x${"0".repeat(65)}`,
    `0X${"0".repeat(64)}`,
    "0".repeat(66),
    `0x${"0".repeat(63)}g`,
  ])("bytes32ToRunId rejects malformed %j", (hex) => {
    expect(() => bytes32ToRunId(hex)).toThrow(TypeError);
  });

  it("bytes32ToRunId rejects a value with non-zero high bytes", () => {
    expect(() => bytes32ToRunId(`0x${"0".repeat(31)}1${"0".repeat(32)}`)).toThrow(RangeError);
  });
});
