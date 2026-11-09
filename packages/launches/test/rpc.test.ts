import { describe, expect, it } from "vitest";
import { demoChain, DEMO_HEAD } from "../testing";
import { PONS_V2_FACTORY, TOPICS } from "../src/pons";
import { ChainReader, RpcUnavailableError, spanLimit } from "../src/rpc";

const A = "https://a.test";
const B = "https://b.test";

describe("refusals from public endpoints", () => {
  // Each message was answered by a public Robinhood Chain endpoint on 2026-11-09 (docs/OPEN_ITEMS.md item 28).
  it.each([
    ["invalid argument 0: block range exceeds maximum 50000", 50_000],
    ["eth_getLogs block range too large (max 10001 blocks)", 10_001],
    ["block range exceeds maximum allowed (max=10000, requested=10001)", 10_000],
    ["query spans 30001 blocks (109826946 to 109856946), but only 30000 are allowed for this request; narrow the block range, or add an address filter", 30_000],
    ["eth_getLogs block range exceeds 100 blocks", 100],
    ["query exceeds max block range 2000", 2_000],
  ])("reads the limit in %j", (message, limit) => {
    expect(spanLimit(message)).toEqual({ refused: true, limit });
  });

  it("does not mistake other errors for a span limit", () => {
    expect(spanLimit("invalid argument 0: 'address' filter exceeds the maximum of 10 addresses per request").refused).toBe(false);
    expect(spanLimit("execution reverted").refused).toBe(false);
    expect(spanLimit("header not found").refused).toBe(false);
  });
});

describe("ChainReader", () => {
  it("cuts a log query to an endpoint's widest span, learned from its refusal", async () => {
    const chain = demoChain({ [A]: { maxSpan: 10_001, spanMessage: (limit) => `eth_getLogs block range too large (max ${limit} blocks)` } });
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [A], fetch: chain.fetch });
    const logs = await reader.getLogs({ address: PONS_V2_FACTORY, topics: [[TOPICS.tokenLaunched]], fromBlock: DEMO_HEAD - 199_999n, toBlock: DEMO_HEAD });
    expect(logs.length).toBe(10);
    const spans = chain.log.filter((entry) => entry.method === "eth_getLogs").map((entry) => {
      const filter = entry.params[0] as { fromBlock: string; toBlock: string };
      return Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n);
    });
    // One refusal, then nothing wider than the limit.
    expect(spans.filter((span) => span > 10_001)).toHaveLength(1);
    expect(spans.slice(1).every((span) => span <= 10_001)).toBe(true);
    // Sorted oldest first, no duplicates.
    const blocks = logs.map((log) => BigInt(log.blockNumber));
    expect([...blocks].sort((x, y) => (x < y ? -1 : 1))).toEqual(blocks);
  });

  it("asks an endpoint with a measured span in parallel straight away, and is never refused", async () => {
    const chain = demoChain({ [A]: { maxSpan: 10_000 } });
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [{ url: A, maxSpan: 10_000 }], fetch: chain.fetch });
    const logs = await reader.getLogs({ address: PONS_V2_FACTORY, topics: [[TOPICS.tokenLaunched]], fromBlock: DEMO_HEAD - 99_999n, toBlock: DEMO_HEAD });
    expect(logs.length).toBeGreaterThan(0);
    expect(reader.stats).toEqual({ requests: 10, refused: 0 });
  });

  it("sends a query without an address only where one is answered", async () => {
    const chain = demoChain({ [A]: { needsAddress: true }, [B]: {} });
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [A, B], fetch: chain.fetch });
    const logs = await reader.getLogs({ topics: [[TOPICS.curveBuy, TOPICS.curveSell]], fromBlock: DEMO_HEAD - 9_999n, toBlock: DEMO_HEAD });
    expect(logs.length).toBeGreaterThan(0);
    const topicOnly = chain.log.filter((entry) => entry.method === "eth_getLogs");
    expect(topicOnly.map((entry) => entry.url)).toEqual([A, B]);
    expect([...reader.served]).toEqual(["b.test"]);
  });

  it("splits an address list to what an endpoint accepts", async () => {
    const chain = demoChain({ [A]: { maxAddresses: 2 } });
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [A], fetch: chain.fetch });
    const curves = chain.launches.map((launch) => launch.curve);
    const logs = await reader.getLogs({ address: curves, topics: [[TOPICS.curveBuy, TOPICS.curveSell]], fromBlock: DEMO_HEAD - 49_999n, toBlock: DEMO_HEAD });
    expect(logs.length).toBe(27 + 12 + 18 + 4);
    const sent = chain.log.filter((entry) => entry.method === "eth_getLogs").map((entry) => (entry.params[0] as { address: string | string[] }).address);
    expect(sent.slice(1).every((address) => !Array.isArray(address) || address.length <= 2)).toBe(true);
  });

  it("moves on from an endpoint that is down or rate limited", async () => {
    const chain = demoChain({ [A]: { down: true }, [B]: { rateLimited: true }, "https://c.test": {} });
    const reader = new ChainReader({ callEndpoints: [A, B, "https://c.test"], logEndpoints: [A, B, "https://c.test"], fetch: chain.fetch });
    expect(await reader.blockNumber()).toBe(DEMO_HEAD);
    const logs = await reader.getLogs({ address: PONS_V2_FACTORY, topics: [[TOPICS.tokenLaunched]], fromBlock: DEMO_HEAD - 49_999n, toBlock: DEMO_HEAD });
    expect(logs.length).toBeGreaterThan(0);
    expect(reader.stats.refused).toBeGreaterThanOrEqual(4);
  });

  it("gives up with every reason when nothing answers", async () => {
    const chain = demoChain({ [A]: { down: true } });
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [A], fetch: chain.fetch });
    await expect(reader.blockNumber()).rejects.toBeInstanceOf(RpcUnavailableError);
    await expect(reader.getLogs({ address: PONS_V2_FACTORY, topics: [], fromBlock: 1n, toBlock: 2n })).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it("sends plain text, which needs no CORS preflight, and JSON to an endpoint that asks for it", async () => {
    const chain = demoChain({ [A]: { jsonOnly: true }, [B]: {} });
    const types: string[] = [];
    const fetch = (input: string, init: RequestInit) => {
      types.push(`${input} ${new Headers(init.headers).get("content-type")}`);
      return chain.fetch(input, init);
    };
    const reader = new ChainReader({ callEndpoints: [B, A], logEndpoints: [A], fetch });
    expect(await reader.blockNumber()).toBe(DEMO_HEAD);
    await reader.getLogs({ address: PONS_V2_FACTORY, topics: [], fromBlock: DEMO_HEAD - 99n, toBlock: DEMO_HEAD });
    await reader.getLogs({ address: PONS_V2_FACTORY, topics: [], fromBlock: DEMO_HEAD - 99n, toBlock: DEMO_HEAD });
    expect(types).toEqual([`${B} text/plain;charset=UTF-8`, `${A} text/plain;charset=UTF-8`, `${A} application/json`, `${A} application/json`]);
    expect(reader.stats.refused).toBe(0);
  });

  it("warms the log endpoint's connection while the first call is under way", async () => {
    const chain = demoChain();
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [B], fetch: chain.fetch });
    reader.warm();
    await reader.blockNumber();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chain.log.map((entry) => entry.url).sort()).toEqual([A, B]);
  });

  it("only ever reads", async () => {
    const chain = demoChain();
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [A], fetch: chain.fetch });
    await expect(reader.call("eth_sendRawTransaction", ["0x00"])).rejects.toThrow(/not a read/);
    await expect(reader.call("eth_sendTransaction", [{}])).rejects.toThrow(/not a read/);
    expect(chain.log).toHaveLength(0);
  });

  it("returns nothing for an empty range or an empty address list", async () => {
    const chain = demoChain();
    const reader = new ChainReader({ callEndpoints: [A], logEndpoints: [A], fetch: chain.fetch });
    expect(await reader.getLogs({ topics: [], fromBlock: 10n, toBlock: 9n })).toEqual([]);
    expect(await reader.getLogs({ address: [], topics: [], fromBlock: 1n, toBlock: 9n })).toEqual([]);
    expect(chain.log).toHaveLength(0);
  });
});
