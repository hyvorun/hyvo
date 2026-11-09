import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, toHex } from "viem";
import { DEMO_ASSETS, DEMO_HEAD, DEMO_IMPOSTOR, DEMO_LAUNCHES, DEMO_OLDER, DEMO_TIME, DEMO_V1, demoChain, fakeAddress } from "../testing";
import { FACTORY_ABI, PONS_V2_FACTORY } from "../src/pons";
import { ChainReader, type RawLog } from "../src/rpc";
import { decodeFactoryLogs, findLaunchEvent, measurePace, readCurveTrades, readLaunch, readLaunches, readMovers, scanFactory, summarizeTrades, type Asset } from "../src/read";

const URL = "https://rpc.test";
const SIX_HOURS = BigInt(Math.round(6 * 3600 * 9.6));

function setup(rules = {}) {
  const chain = demoChain({ [URL]: rules });
  const reader = new ChainReader({ callEndpoints: [URL], logEndpoints: [URL], fetch: chain.fetch });
  return { chain, reader, cache: new Map<string, Asset>() };
}

describe("reading launches", () => {
  it("finds the factory's launches in a window, newest first, with the graduations", async () => {
    const { reader } = setup();
    const scan = await scanFactory(reader, DEMO_HEAD - SIX_HOURS, DEMO_HEAD);
    expect(scan.launches.map((launch) => launch.token)).toEqual(DEMO_LAUNCHES.map((launch) => launch.token));
    expect(scan.launches[0]!.timestamp).toBe(DEMO_LAUNCHES[0]!.launchedAt);
    expect(scan.graduations).toHaveLength(1);
    expect(scan.graduations[0]!.token).toBe(DEMO_LAUNCHES[5]!.token);
  });

  it("drops logs that are not the factory's, or not in the range asked for", () => {
    const topics = encodeEventTopics({ abi: FACTORY_ABI, eventName: "TokenLaunched", args: { token: fakeAddress("t"), curve: fakeAddress("c"), deployer: fakeAddress("d") } });
    const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [fakeAddress("pair"), 0n, 1n]);
    const log = (address: string, block: bigint): RawLog => ({
      address: address as RawLog["address"],
      topics: topics as RawLog["topics"],
      data,
      blockNumber: toHex(block),
      transactionHash: `0x${"ab".repeat(32)}`,
      logIndex: "0x0",
    });
    const out = decodeFactoryLogs([log(PONS_V2_FACTORY.toLowerCase(), 50n), log(fakeAddress("elsewhere"), 50n), log(PONS_V2_FACTORY, 500n)], 10n, 100n);
    expect(out.launches).toHaveLength(1);
    // A log whose data does not fit the event is dropped too.
    expect(decodeFactoryLogs([{ ...log(PONS_V2_FACTORY, 50n), data: "0x1234" }], 10n, 100n).launches).toHaveLength(0);
  });

  it("reads each curve's state and the pair assets, at one block", async () => {
    const { reader, cache } = setup();
    const scan = await scanFactory(reader, DEMO_HEAD - SIX_HOURS, DEMO_HEAD);
    const { launches, read } = await readLaunches(reader, scan.launches, cache);
    expect(read).toEqual({ block: DEMO_HEAD, timestamp: DEMO_TIME });
    const glint = launches.find((launch) => launch.symbol === "GLINT")!;
    expect(glint.pair.symbol).toBe("USDG");
    expect(glint.pair.decimals).toBe(6);
    expect(glint.liquidity).toBe(642_900_000n);
    expect(glint.creatorTaxBps).toBe(200);
    expect(glint.graduated).toBe(false);
    expect(glint.launchedAt).toBe(DEMO_LAUNCHES[2]!.launchedAt);
    const brisk = launches.find((launch) => launch.symbol === "BRISK")!;
    expect(brisk.graduated).toBe(true);
    expect(cache.get(DEMO_ASSETS.nvda.address.toLowerCase())?.symbol).toBe("NVDA");
  });

  it("ranks the busiest curves and counts only real Pons curves", async () => {
    const { reader, cache } = setup();
    const scan = await scanFactory(reader, DEMO_HEAD - SIX_HOURS, DEMO_HEAD);
    const { launches } = await readLaunches(reader, scan.launches, cache);
    const movers = await readMovers(reader, { fromBlock: DEMO_HEAD - 9_999n, toBlock: DEMO_HEAD, known: launches, limit: 5, cache });
    // The impostor emitted the most events, and is left out.
    expect(movers.rows.map((row) => row.launch.symbol)).toEqual(["FIZZ", "EMBER", "MOTE"]);
    expect(movers.dropped).toBe(1);
    expect(movers.rows.some((row) => row.launch.curve === DEMO_IMPOSTOR.curve)).toBe(false);
    expect(movers.curves).toBe(3);
    expect(movers.trades).toBe(27 + 18 + 12);
    expect(movers.everyCurve).toBe(true);
    // EMBER launched outside the window and was verified through the factory's record.
    const ember = movers.rows[1]!;
    expect(ember.launch.token).toBe(DEMO_OLDER.token);
    expect(ember.launch.symbol).toBe("EMBER");
    expect(ember.activity.traders).toBe(11);
    expect(movers.read?.block).toBe(DEMO_HEAD);
  });

  it("falls back to the known curves when no endpoint answers a query without an address", async () => {
    const { reader, cache } = setup({ needsAddress: true });
    const scan = await scanFactory(reader, DEMO_HEAD - SIX_HOURS, DEMO_HEAD);
    const { launches } = await readLaunches(reader, scan.launches, cache);
    const movers = await readMovers(reader, { fromBlock: DEMO_HEAD - 9_999n, toBlock: DEMO_HEAD, known: launches, limit: 5, cache });
    expect(movers.everyCurve).toBe(false);
    expect(movers.rows.map((row) => row.launch.symbol)).toEqual(["FIZZ", "MOTE"]);
  });

  it("sums a curve's trades in its pair asset", async () => {
    const { reader } = setup();
    const trades = await readCurveTrades(reader, DEMO_LAUNCHES[0]!.curve, DEMO_HEAD - 49_999n, DEMO_HEAD);
    const summary = summarizeTrades(trades).get(DEMO_LAUNCHES[0]!.curve.toLowerCase())!;
    expect(summary.trades).toBe(27);
    expect(summary.buys).toBe(18);
    expect(summary.sells).toBe(9);
    expect(summary.traders).toBe(15);
    // Buys count what was spent; sells what was paid out plus fee and tax: the same gross amounts.
    const expected = Array.from({ length: 27 }, (_, i) => 20_000_000_000_000_000n + BigInt(i) * 1_000_000_000_000_000n).reduce((a, b) => a + b, 0n);
    expect(summary.volume).toBe(expected);
  });
});

describe("one launch", () => {
  it("reads a V2 launch in full", async () => {
    const { reader, cache } = setup();
    const lookup = await readLaunch(reader, DEMO_LAUNCHES[4]!.token, cache);
    expect(lookup.kind).toBe("v2");
    if (lookup.kind !== "v2") return;
    const detail = lookup.detail;
    expect(detail.symbol).toBe("PLUME");
    expect(detail.pair.symbol).toBe("NVDA");
    expect(detail.phase).toBe("curve");
    expect(detail.creatorTaxBps).toBe(50);
    expect(detail.feeBps).toBe(100);
    expect(detail.snipeTaxSeconds).toBe(3);
    expect(detail.read.block).toBe(DEMO_HEAD);
  });

  it("says when a token is a V1 launch, or no launch at all", async () => {
    const { reader, cache } = setup();
    const v1 = await readLaunch(reader, DEMO_V1.token, cache);
    expect(v1.kind).toBe("v1");
    if (v1.kind === "v1") expect(v1.paired?.symbol).toBe("WETH");
    const none = await readLaunch(reader, DEMO_ASSETS.usdg.address, cache);
    expect(none).toMatchObject({ kind: "none", symbol: "USDG" });
    await expect(readLaunch(reader, "0x0000000000000000000000000000000000000000", cache)).rejects.toThrow();
  });

  it("finds the launch event from the launch time and the chain's pace", async () => {
    const { reader } = setup();
    const head = { block: DEMO_HEAD, timestamp: DEMO_TIME };
    const pace = await measurePace(reader, head);
    expect(pace).toBeCloseTo(9.6, 1);
    const target = DEMO_LAUNCHES[8]!;
    const event = await findLaunchEvent(reader, target.token, { launchedAt: target.launchedAt, head, blocksPerSecond: pace });
    expect(event?.block).toBe(target.block);
    expect(event?.creator).toBe(target.creator);
    expect(await findLaunchEvent(reader, fakeAddress("nobody"), { launchedAt: DEMO_TIME - 600, head, blocksPerSecond: pace })).toBeNull();
  });

  it("finds an old launch even when the measured pace is off, from the block times", async () => {
    const { chain, reader } = setup();
    const head = { block: DEMO_HEAD, timestamp: DEMO_TIME };
    // 9.0 blocks a second against the chain's 9.6 puts a 26-hour-old launch about 56,000 blocks off.
    const event = await findLaunchEvent(reader, DEMO_OLDER.token, { launchedAt: DEMO_OLDER.launchedAt, head, blocksPerSecond: 9.0 });
    expect(event?.block).toBe(DEMO_OLDER.block);
    // A few block headers, then one narrow log query.
    const logQueries = chain.log.filter((entry) => entry.method === "eth_getLogs");
    expect(logQueries).toHaveLength(1);
  });

  it("reads unknown pair assets in the same call as the curves", async () => {
    const { chain, reader, cache } = setup();
    const scan = await scanFactory(reader, DEMO_HEAD - SIX_HOURS, DEMO_HEAD);
    const before = chain.log.filter((entry) => entry.method === "eth_call").length;
    await readLaunches(reader, scan.launches, cache);
    expect(chain.log.filter((entry) => entry.method === "eth_call").length - before).toBe(1);
    expect(cache.size).toBe(3);
  });
});
