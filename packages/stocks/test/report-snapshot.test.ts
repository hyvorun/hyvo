import { createPublicClient, custom, getAddress, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { STOCK_FACTORY, STOCK_IMPLEMENTATION, STOCK_REGISTRY } from "../src/contracts";
import { divideToDecimal } from "../src/decimal";
import { stockReport } from "../src/report";
import { SNAPSHOT, searchSnapshot, snapshotByAddress, snapshotByTicker } from "../src/snapshot";
import { fixture, recordedAt, recordedDirectory, replayClient } from "./helpers";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

describe("a report from recorded chain answers", () => {
  it("finds NVDA in the factory's records, with its multiplier and its Chainlink price", async () => {
    const now = Math.floor(Date.parse(recordedAt("rpc-nvda.json")) / 1000);
    const report = await stockReport(replayClient("rpc-nvda.json"), NVDA, { directory: async () => recordedDirectory(), now });
    expect(report.verdict).toEqual({ kind: "registered", uid: "0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5" });
    expect(report.system).toEqual({ beaconIsRegistry: true, namesRegistry: true });
    expect(report.reading.implementation).toBe(STOCK_IMPLEMENTATION);
    expect(report.reading.token?.symbol).toBe("NVDA");
    expect(report.reading.token?.interfaces).toEqual({ scaledUIAmount: true, newUIMultiplier: true, balances: true });
    expect(report.multiplier?.value).toBe("1.000775159164630595");
    expect(report.movement).toEqual({ transfers: "open", tokenPaused: false, registryPaused: false, oracle: "publishing" });
    expect(report.listed?.symbol).toBe("NVDA");

    expect(report.feed?.kind).toBe("read");
    if (report.feed?.kind !== "read") return;
    expect(report.feed.listing.proxy).toBe("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15");
    expect(report.feed.reading.blockNumber).toBe(report.reading.blockNumber);
    const { answer } = report.feed.reading;
    expect(report.feed.price.perShare).toEqual({ value: divideToDecimal(answer * 10n ** 18n, report.multiplier!.raw * 10n ** 8n, 8) });
  });

  it("finds no stock token in a contract that is not one, and reads no price for it", async () => {
    const report = await stockReport(replayClient("rpc-factory.json"), STOCK_FACTORY, { directory: async () => recordedDirectory() });
    expect(report.verdict.kind).toBe("not-a-stock-token");
    expect(report.feed).toBeNull();
    expect(report.multiplier).toBeNull();
  });

  it("finds no contract at an empty address", async () => {
    const report = await stockReport(replayClient("rpc-empty.json"), "0x000000000000000000000000000000000000dEaD", { directory: async () => recordedDirectory() });
    expect(report.verdict.kind).toBe("no-code");
  });

  it("fails when the chain answers none of the token's reads, instead of finding no stock token", async () => {
    // The block and the code come back, but the one eth_call that holds every other read is refused, as a busy
    // endpoint's HTTP 429 would refuse it: viem then hands back a failure for each of the batch's reads.
    const recording = fixture<{ calls: { method: string; params: unknown; result: unknown }[] }>("rpc-nvda.json");
    const answers = new Map(recording.calls.map((call) => [`${call.method} ${JSON.stringify(call.params)}`, call.result]));
    const busy = createPublicClient({
      transport: custom(
        {
          async request({ method, params }: { method: string; params?: unknown }) {
            if (method === "eth_call") throw new Error("HTTP request failed. Status: 429");
            return answers.get(`${method} ${JSON.stringify(params ?? [])}`);
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    await expect(stockReport(busy, NVDA, { directory: async () => recordedDirectory() })).rejects.toThrow("429");
  });

  it("says when Chainlink's directory could not be read, and keeps the rest", async () => {
    const report = await stockReport(replayClient("rpc-nvda.json"), NVDA, {
      directory: async () => {
        throw new Error("offline");
      },
    });
    expect(report.verdict.kind).toBe("registered");
    expect(report.feed).toEqual({ kind: "directory-failed", message: "offline" });
  });
});

describe("Hyvo's list of stock tokens", () => {
  const { tokens } = SNAPSHOT;

  it("holds every token the factory deployed, once", () => {
    expect(SNAPSHOT.factory).toBe(STOCK_FACTORY);
    expect(tokens.length).toBe(SNAPSHOT.factoryNonce - 1);
    expect(new Set(tokens.map((token) => token.address)).size).toBe(tokens.length);
    expect(new Set(tokens.map((token) => token.uid)).size).toBe(tokens.length);
    for (const token of tokens) expect(getAddress(token.address)).toBe(token.address);
    const blocks = tokens.map((token) => token.deployed.block);
    expect([...blocks].sort((a, b) => a - b)).toEqual(blocks);
  });

  it("holds a complete multiplier history: each update starts from the value in effect when it was sent", () => {
    for (const token of tokens) {
      let previous: (typeof token.multiplierUpdates)[number] | null = null;
      for (const update of token.multiplierUpdates) {
        const sent = Date.parse(update.time) / 1000;
        // src/Stock.sol refuses an effective time in the past.
        expect(update.effectiveAt).toBeGreaterThanOrEqual(sent);
        const inEffect = previous === null ? "1000000000000000000" : previous.effectiveAt <= sent ? previous.newMultiplier : previous.oldMultiplier;
        expect(update.oldMultiplier, `${token.symbol} in block ${update.block}`).toBe(inEffect);
        previous = update;
      }
    }
  });

  it("finds tokens by ticker, address and name", () => {
    expect(snapshotByTicker("nvda").map((token) => token.address)).toEqual([NVDA]);
    expect(snapshotByAddress(NVDA.toLowerCase())?.symbol).toBe("NVDA");
    expect(snapshotByTicker("NOPE")).toEqual([]);
    expect(searchSnapshot("nvid")[0]?.symbol).toBe("NVDA");
    expect(searchSnapshot("NVDA")[0]?.symbol).toBe("NVDA");
    expect(searchSnapshot("").length).toBe(tokens.length);
  });

  it("names the registry every token uses", () => {
    expect(STOCK_REGISTRY).toBe("0xe10b6f6B275de231345c20D14Ab812db62151b00");
  });
});
