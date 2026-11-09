import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckReport } from "@hyvo/check";
import { describe, expect, it } from "vitest";
import { observe } from "../src/watch";
import { addToken, parseWatchlist, removeToken, watchlistPath } from "../src/watchlist";
import { OWNER, run, sampleReport, testContext, TOKEN } from "./helpers";

const NEW_OWNER = "0x000000000000000000000000000000000000dEaD";

function withFinding(report: CheckReport, id: string, status: "found" | "not_found" | "skipped", evidence = "changed"): CheckReport {
  return { ...report, findings: report.findings.map((f) => (f.id === id ? { ...f, status, evidence } : f)) };
}

describe("what watch compares", () => {
  it("reports nothing for the first read", () => {
    expect(observe(null, sampleReport()).changes).toEqual([]);
  });

  it("reports nothing when nothing changed but the block", () => {
    const first = observe(null, sampleReport());
    expect(observe(first.known, sampleReport({ block: 107_600_000n })).changes).toEqual([]);
  });

  it("reports a check moving between found and not found, with the new evidence", () => {
    const first = observe(null, sampleReport());
    const next = withFinding(sampleReport(), "sell-simulation", "found", "the sell reverted with Error(\"no\")");
    expect(observe(first.known, next).changes).toEqual([
      { what: "Sell or transfer shortfall", from: "not found", to: "found", evidence: "the sell reverted with Error(\"no\")" },
    ]);
  });

  it("never counts a check that could not look as a change, and remembers the last status read", () => {
    const first = observe(null, sampleReport());
    const skipped = observe(first.known, withFinding(sampleReport(), "pause", "skipped"));
    expect(skipped.changes).toEqual([]);
    expect(observe(skipped.known, sampleReport()).changes).toEqual([]);
    expect(observe(skipped.known, withFinding(sampleReport(), "pause", "found")).changes).toMatchObject([{ what: "Pause or trading switch", from: "not found", to: "found" }]);
  });

  it("reports a check read for the first time only when it found something", () => {
    const first = observe(null, withFinding(sampleReport(), "holders", "skipped"));
    expect(observe(first.known, withFinding(sampleReport(), "holders", "not_found")).changes).toEqual([]);
    expect(observe(first.known, withFinding(sampleReport(), "holders", "found")).changes).toMatchObject([{ what: "Top holders", from: "not read before", to: "found" }]);
  });

  it("reports the owner, the implementation, the supply and the venue changing", () => {
    const first = observe(null, sampleReport());
    const base = sampleReport();
    const next = sampleReport({
      code: { ...base.code, owner: NEW_OWNER, proxyImplementation: "0x2222222222222222222222222222222222222222" },
      token: { ...base.token, totalSupply: base.token.totalSupply! * 2n },
      exit: { ...base.exit!, venue: { kind: "pons-curve", curve: "0x3333333333333333333333333333333333333333", curveFeeBps: 100, creatorTaxBps: 0, snipeTaxBpsNow: 0 } },
    });
    expect(observe(first.known, next).changes).toEqual([
      { what: "Owner address", from: "0x6C1A…5d2E", to: "0x0000…dEaD" },
      { what: "Proxy implementation", from: "none", to: "0x2222…2222" },
      { what: "Total supply", from: "1,000,000", to: "2,000,000" },
      { what: "Trading venue", from: "Uniswap V2 pair 0x1111…1111", to: "Pons v2 curve 0x3333…3333" },
    ]);
  });

  it("ignores an owner it could not read", () => {
    const first = observe(null, sampleReport());
    const base = sampleReport();
    const unread = withFinding(sampleReport({ code: { ...base.code, owner: null } }), "owner", "skipped");
    expect(observe(first.known, unread).changes).toEqual([]);
  });
});

describe("hyvo watch", () => {
  function changing(): () => Promise<CheckReport> {
    let calls = 0;
    return async () => {
      calls++;
      if (calls === 1) return sampleReport();
      const base = sampleReport({ block: 107_600_000n });
      return { ...base, code: { ...base.code, owner: NEW_OWNER } };
    };
  }

  it("prints a first read, then each change with the disclaimer, and stops after --count", async () => {
    const slept: number[] = [];
    const c = testContext({ checkToken: changing(), sleep: async (ms) => void slept.push(ms) });
    expect(await run(["watch", TOKEN, "--count", "2", "--interval", "60"], c)).toBe(0);
    const out = c.stdout();
    expect(slept).toEqual([60_000]);
    expect(out).toContain("HYVO WATCH   1 token · every 60 s · robinhood.drpc.org · 2 rounds");
    expect(out).toContain("first read at block 107512345: 5 found, 5 not found, 1 skipped");
    expect(out).toContain("Measured on-chain at block 107512345. Not a trading signal.");
    expect(out).toContain("Sample Token (SMPL) 0x8EEe…e758 · block 107600000");
    expect(out).toContain(`Owner address: 0x6C1A…5d2E → 0x0000…dEaD`);
    expect(out).toContain("Measured on-chain at block 107600000. Not a trading signal.");
    expect(out.trimEnd().endsWith("done.")).toBe(true);
  });

  it("writes one JSON event per line", async () => {
    const c = testContext({ checkToken: changing() });
    await run(["watch", TOKEN, "--count", "2", "--json"], c);
    const events = c.stdout().trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((e) => e.event)).toEqual(["baseline", "change"]);
    expect(events[0]).toMatchObject({ token: TOKEN, block: "107512345", disclaimer: "Measured on-chain at block 107512345. Not a trading signal." });
    expect(events[0].findings).toHaveLength(11);
    expect(events[1]).toMatchObject({
      block: "107600000",
      changes: [{ what: "Owner address", from: "0x6C1A…5d2E", to: "0x0000…dEaD" }],
      disclaimer: "Measured on-chain at block 107600000. Not a trading signal.",
    });
  });

  it("reports a failed round and goes on", async () => {
    let calls = 0;
    const c = testContext({
      checkToken: async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
        return sampleReport();
      },
    });
    await run(["watch", TOKEN, "--count", "2", "--json"], c);
    const events = c.stdout().trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((e) => e.event)).toEqual(["error", "baseline"]);
    expect(events[0].message).toBe("could not reach robinhood.drpc.org (ETIMEDOUT)");
  });

  it("stops cleanly on Ctrl+C", async () => {
    const stop = new AbortController();
    const c = testContext({
      interrupt: () => stop.signal,
      checkToken: async () => sampleReport(),
      sleep: async () => {
        stop.abort();
      },
    });
    expect(await run(["watch", TOKEN], c)).toBe(0);
    expect(c.stdout().trimEnd().endsWith("stopped.")).toBe(true);
  });

  it("watches the watchlist when no token is given, and needs something to watch", async () => {
    const empty = testContext();
    expect(await run(["watch"], empty)).toBe(64);
    expect(empty.stderr()).toContain("nothing to watch");

    const seen: string[] = [];
    const c = testContext({
      checkToken: async (address) => {
        seen.push(address);
        return sampleReport();
      },
    });
    writeFileSync(watchlistPath(c.ctx.configDir), JSON.stringify({ tokens: [TOKEN.toLowerCase(), OWNER], labels: { [TOKEN]: "mine" } }));
    await run(["watch", "--count", "1"], c);
    expect(seen).toEqual([TOKEN, OWNER]);
    expect(c.stdout()).toContain("mine 0x8EEe…e758");
  });

  it("refuses an interval under a minute", async () => {
    const c = testContext();
    expect(await run(["watch", TOKEN, "--interval", "5"], c)).toBe(64);
  });
});

describe("the watchlist", () => {
  it("adds, labels, lists and removes tokens in a local file", async () => {
    const c = testContext();
    expect(await run(["watchlist", "add", TOKEN.toLowerCase(), "--label", "my token"], c)).toBe(0);
    expect(c.stdout()).toContain("added 0x8EEe…e758");
    const file = watchlistPath(c.ctx.configDir);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ tokens: [TOKEN], labels: { [TOKEN]: "my token" } });

    const again = testContext({ configDir: c.ctx.configDir });
    await run(["watchlist", "add", TOKEN, "--json"], again);
    expect(JSON.parse(again.stdout())).toEqual({ added: TOKEN, label: "my token", already: true });

    const show = testContext({ configDir: c.ctx.configDir });
    await run(["watchlist"], show);
    expect(show.stdout()).toContain(`${TOKEN}  my token`);
    expect(show.stdout()).toContain(`file  ${file}`);

    const rm = testContext({ configDir: c.ctx.configDir });
    await run(["watchlist", "rm", TOKEN], rm);
    expect(rm.stdout()).toContain("removed 0x8EEe…e758");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ tokens: [], labels: {} });
  });

  it("prints its path and writes nothing until something is added", async () => {
    const c = testContext();
    await run(["watchlist", "path"], c);
    expect(c.stdout()).toBe(`${join(c.ctx.configDir, "watchlist.json")}\n`);
    await run(["watchlist"], c);
    expect(existsSync(watchlistPath(c.ctx.configDir))).toBe(false);
  });

  it("reads a hand-edited file tolerantly", () => {
    expect(parseWatchlist({ tokens: ["nope", TOKEN.toLowerCase(), TOKEN, 7], labels: { [TOKEN.toLowerCase()]: "a\u0007b", "0xbad": "x" } })).toEqual({
      tokens: [TOKEN],
      labels: { [TOKEN]: "a b" },
    });
    expect(parseWatchlist("garbage")).toEqual({ tokens: [], labels: {} });
  });

  it("adds and removes without touching the other entries", () => {
    const one = addToken({ tokens: [OWNER], labels: { [OWNER]: "x" } }, TOKEN, "  ");
    expect(one).toEqual({ next: { tokens: [OWNER, TOKEN], labels: { [OWNER]: "x" } }, already: false });
    expect(removeToken(one.next, TOKEN.toLowerCase())).toEqual({ next: { tokens: [OWNER], labels: { [OWNER]: "x" } }, removed: true });
  });

  it("refuses what is not an address, and unknown subcommands", async () => {
    for (const argv of [["watchlist", "add", "0x12"], ["watchlist", "drop", TOKEN], ["watchlist", "add"]]) {
      const c = testContext();
      expect(await run(argv, c), argv.join(" ")).toBe(64);
    }
  });
});
