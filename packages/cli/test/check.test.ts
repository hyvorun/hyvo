import { CheckError, type CheckOptions } from "@hyvo/check";
import { describe, expect, it } from "vitest";
import { hasBannedWords } from "../../check/src/output/copy";
import { makePalette, stripAnsi } from "../src/color";
import { checkDisclaimer, renderCheck, requestsLine } from "../src/format/check";
import { OWNER, run, sampleReport, testContext, TOKEN } from "./helpers";

const plain = makePalette(false);

describe("the text report", () => {
  const text = renderCheck(sampleReport(), { palette: plain, width: null, rpcUrl: "https://robinhood.drpc.org" });

  it("names the token, the chain and the block", () => {
    expect(text).toContain("HYVO CHECK   Sample Token (SMPL)");
    expect(text).toContain("Robinhood Chain · 4663");
    expect(text).toContain(`${TOKEN} · block 107512345`);
  });

  it("lists every finding with its status and its evidence, in the report's order", () => {
    const report = sampleReport();
    let at = 0;
    for (const f of report.findings) {
      const label = { found: "found", not_found: "not found", skipped: "skipped" }[f.status];
      const index = text.indexOf(`${label.padEnd(11)}${f.title}`, at);
      expect(index, f.id).toBeGreaterThan(at);
      expect(text.indexOf(f.evidence, index), f.id).toBeGreaterThan(index);
      at = index;
    }
  });

  it("keeps each evidence on one line when stdout is not a terminal", () => {
    const sell = sampleReport().findings.find((f) => f.id === "sell-simulation")!;
    expect(text.split("\n")).toContain(`             ${sell.evidence}`);
  });

  it("wraps evidence to the terminal width", () => {
    const sell = sampleReport().findings.find((f) => f.id === "sell-simulation")!;
    for (const width of [80, 60]) {
      const narrow = renderCheck(sampleReport(), { palette: plain, width, rpcUrl: "https://robinhood.drpc.org" });
      for (const line of narrow.split("\n")) expect(line.length, line).toBeLessThanOrEqual(width);
      expect(narrow).not.toContain(sell.evidence);
      expect(narrow.split("\n").map((line) => line.trim()).join(" ")).toContain(sell.evidence);
    }
  });

  it("shows the exit simulation step by step", () => {
    expect(text).toContain("Exit simulation   Uniswap V2 pair 0x1111…1111 · 0.001 ETH in · inside one eth_call");
    expect(text).toMatch(/^ {2}step {8}promised {7}arrived {8}short {4}gas$/m);
    expect(text).toMatch(/^ {2}buy {9}79\.83 SMPL {5}79\.83 SMPL {5}0% {7}133,547$/m);
    expect(text).toMatch(/^ {2}transfer {4}7\.983 SMPL {5}7\.983 SMPL {5}0%$/m);
    expect(text).toMatch(/^ {2}sell {8}0\.000894 ETH {3}0\.000894 ETH {3}0% {7}70,281$/m);
    expect(text).toContain("round trip  0.6% lost: the part sold cost 0.0009 ETH at the buy's average price, and 0.0008946 ETH came back");
  });

  it("shows a reverted step with its reason, and what was not tried", () => {
    const base = sampleReport();
    const report = sampleReport({
      exit: { ...base.exit!, sell: { ok: false, promised: null, arrived: 0n, shortfallPct: null, gas: 50_000n, reason: 'Error("TRANSFER_FAILED")' }, roundTrip: null },
    });
    const out = renderCheck(report, { palette: plain, width: null, rpcUrl: "https://robinhood.drpc.org" });
    expect(out).toContain('sell        reverted: Error("TRANSFER_FAILED")');
    expect(out).not.toMatch(/^  round trip/m);
    const none = renderCheck(sampleReport({ exit: { ...base.exit!, transfer: null, sell: null, roundTrip: null } }), {
      palette: plain,
      width: null,
      rpcUrl: "https://robinhood.drpc.org",
    });
    expect(none).toContain("transfer    not tried: the buy delivered no tokens");
  });

  it("says where requests went, by host only", () => {
    expect(text).toContain("Read in 2.4 s: 9 requests to robinhood.drpc.org and 1 to sourcify.dev. Nothing was signed or sent.");
    expect(requestsLine(sampleReport(), "https://lb.drpc.org/ogrpc?network=robinhood&dkey=SECRET")).not.toContain("SECRET");
  });

  it("ends with the line every check result carries", () => {
    expect(checkDisclaimer(107_512_345n)).toBe("Measured on-chain at block 107512345. Not a trading signal.");
    expect(text.trimEnd().split("\n").at(-1)).toBe("  Measured on-chain at block 107512345. Not a trading signal.");
  });

  it("gives no verdict and uses no word Hyvo never uses about a token", () => {
    expect(hasBannedWords(text)).toBe(false);
    for (const word of ["risk", "warning", "critical", "caution", "pass", "fail", "score"]) expect(text.toLowerCase()).not.toContain(word);
  });

  it("styles only when asked, and lines up the same either way", () => {
    const colored = renderCheck(sampleReport(), { palette: makePalette(true), width: null, rpcUrl: "https://robinhood.drpc.org" });
    expect(colored).toContain("\u001b[1m");
    expect(text).not.toContain("\u001b[");
    expect(stripAnsi(colored)).toBe(text);
  });

  it("does not print control characters a token put in its name", () => {
    const out = renderCheck(sampleReport({ token: { ...sampleReport().token, name: "Evil\u001b[2J\u0007Name", symbol: "E\nVIL" } }), {
      palette: plain,
      width: null,
      rpcUrl: "https://robinhood.drpc.org",
    });
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
    expect(out).toContain("Evil [2J Name (E VIL)");
  });
});

describe("hyvo check", () => {
  it("passes its options to Hyvo Check and prints the report", async () => {
    let seen: { address: string; options: CheckOptions } | null = null;
    const c = testContext({
      env: { HYVO_BLOCKSCOUT_KEY: "bs-key" },
      checkToken: async (address, options = {}) => {
        seen = { address, options };
        return sampleReport();
      },
    });
    const code = await run(["check", TOKEN, "--eth-in", "0.01", "--block", "100", "--rpc", "https://rpc.example/key"], c);
    expect(code).toBe(0);
    expect(seen!.address).toBe(TOKEN);
    expect(seen!.options.rpcUrls).toEqual(["https://rpc.example/key"]);
    expect(seen!.options.ethIn).toBe(10n ** 16n);
    expect(seen!.options.block).toBe(100n);
    expect(seen!.options.blockscoutKey).toBe("bs-key");
    expect(c.stdout()).toContain("Measured on-chain at block 107512345. Not a trading signal.");
    expect(c.stdout()).not.toContain("bs-key");
    expect(c.stdout()).toContain("9 requests to rpc.example");
  });

  it("is also `hyvo scan`, and reads the RPC from the environment", async () => {
    let rpc: string[] | undefined;
    const c = testContext({
      env: { HYVO_RPC_URL: "https://env-rpc.example" },
      checkToken: async (_address, options = {}) => {
        rpc = options.rpcUrls;
        return sampleReport();
      },
    });
    expect(await run(["scan", TOKEN], c)).toBe(0);
    expect(rpc).toEqual(["https://env-rpc.example"]);
  });

  it("exits 2 with the reason when no report can be made", async () => {
    const c = testContext({
      checkToken: async () => {
        throw new CheckError("not_a_token", `${TOKEN} answers neither totalSupply() nor balanceOf(address): it is not an ERC-20 token`);
      },
    });
    expect(await run(["check", TOKEN], c)).toBe(2);
    expect(c.stderr()).toContain("it is not an ERC-20 token");
    expect(c.stdout()).toBe("");
  });

  it("names the host, never the URL, when the RPC cannot be reached", async () => {
    const c = testContext({
      checkToken: async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
    });
    expect(await run(["check", TOKEN, "--rpc", "https://rpc.example/secret-key"], c)).toBe(2);
    expect(c.stderr()).toContain("could not reach rpc.example (ECONNREFUSED)");
    expect(c.stderr()).not.toContain("secret-key");
  });

  it("keeps the owner address exactly as the report has it", async () => {
    const c = testContext({ checkToken: async () => sampleReport() });
    await run(["check", TOKEN], c);
    expect(c.stdout()).toContain(`owner() returns ${OWNER}`);
  });
});
