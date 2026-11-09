import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { intOption, parseArgs, UsageError, type OptionSpec } from "../src/args";
import { parseBlock, parseEthIn, tokenArgument } from "../src/commands/check";
import { run, testContext } from "./helpers";

const SPEC: OptionSpec = {
  json: { type: "boolean" },
  rpc: { type: "string" },
  limit: { type: "string" },
  help: { type: "boolean", short: "h" },
};

describe("parseArgs", () => {
  it("keeps positionals in order and reads options anywhere", () => {
    expect(parseArgs(["a", "--json", "b", "--rpc", "https://x.example", "c"], SPEC)).toEqual({
      positional: ["a", "b", "c"],
      options: { json: true, rpc: "https://x.example" },
    });
  });

  it("never lets a boolean option swallow the argument after it", () => {
    expect(parseArgs(["--json", "0xabc"], SPEC).positional).toEqual(["0xabc"]);
  });

  it("reads --name=value and short options", () => {
    expect(parseArgs(["--limit=5", "-h"], SPEC).options).toEqual({ limit: "5", help: true });
  });

  it("takes everything after -- as positional", () => {
    expect(parseArgs(["--", "--json", "-h"], SPEC)).toEqual({ positional: ["--json", "-h"], options: {} });
  });

  it("refuses unknown options, missing values and values on booleans", () => {
    expect(() => parseArgs(["--nope"], SPEC)).toThrow(new UsageError("unknown option --nope"));
    expect(() => parseArgs(["-x"], SPEC)).toThrow(/unknown option -x/);
    expect(() => parseArgs(["--rpc"], SPEC)).toThrow(/--rpc needs a value/);
    expect(() => parseArgs(["--rpc="], SPEC)).toThrow(/--rpc needs a value/);
    expect(() => parseArgs(["--json=yes"], SPEC)).toThrow(/--json takes no value/);
  });

  it("checks whole numbers and their range", () => {
    expect(intOption(undefined, "limit", 1, 50, 10)).toBe(10);
    expect(intOption("7", "limit", 1, 50, 10)).toBe(7);
    expect(() => intOption("0", "limit", 1, 50, 10)).toThrow(/between 1 and 50/);
    expect(() => intOption("2.5", "limit", 1, 50, 10)).toThrow(/whole number/);
    expect(() => intOption("-3", "limit", 1, 50, 10)).toThrow(/whole number/);
  });
});

describe("check arguments", () => {
  it("wants exactly one address", () => {
    expect(tokenArgument(["0x8eee67a8aad993f15b4506975b38c52f6d3ce758"])).toBe("0x8eee67a8aad993f15b4506975b38c52f6d3ce758");
    expect(() => tokenArgument([])).toThrow(/missing <token>/);
    expect(() => tokenArgument(["0x123"])).toThrow(/not an address/);
    expect(() => tokenArgument(["0x8eee67a8aad993f15b4506975b38c52f6d3ce758", "extra"])).toThrow(/unexpected argument: extra/);
  });

  it("reads --eth-in as wei, from 1 wei to 1000 ETH", () => {
    expect(parseEthIn("0.001")).toBe(10n ** 15n);
    expect(parseEthIn("1000")).toBe(10n ** 21n);
    expect(() => parseEthIn("0")).toThrow(/more than 0/);
    expect(() => parseEthIn("1000.000000000000000001")).toThrow(/at most 1000/);
    expect(() => parseEthIn("lots")).toThrow(/ETH amount/);
  });

  it("reads --block as a block number", () => {
    expect(parseBlock("107512345")).toBe(107_512_345n);
    expect(() => parseBlock("latest")).toThrow(/block number/);
  });
});

describe("the command table", () => {
  it("prints help and the package version", async () => {
    const help = testContext();
    expect(await run([], help)).toBe(0);
    expect(help.stdout()).toContain("USAGE");
    const version = testContext();
    expect(await run(["--version"], version)).toBe(0);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(version.stdout()).toBe(`${pkg.version}\n`);
  });

  it("shows one command's help with `help <command>` and --help", async () => {
    const a = testContext();
    await run(["help", "verify"], a);
    const b = testContext();
    await run(["verify", "--help"], b);
    expect(a.stdout()).toContain("hyvo verify: recompute");
    expect(a.stdout()).toBe(b.stdout());
  });

  it("answers an unknown command and a usage error with 64 on stderr", async () => {
    const unknown = testContext();
    expect(await run(["mint"], unknown)).toBe(64);
    expect(unknown.stderr()).toContain("unknown command: mint");
    expect(unknown.stdout()).toBe("");
    const usage = testContext();
    expect(await run(["check", "--eth-in", "0", "0x8eee67a8aad993f15b4506975b38c52f6d3ce758"], usage)).toBe(64);
    expect(usage.stderr()).toContain("--eth-in must be more than 0");
  });

  it("has no command that signs, mints, logs in or spends", async () => {
    for (const command of ["login", "mint", "mints", "lp", "alpha", "credits", "tiers", "agree", "wallet"]) {
      const c = testContext();
      expect(await run([command], c), command).toBe(64);
    }
  });
});
