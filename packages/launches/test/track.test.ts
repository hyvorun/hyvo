import { describe, expect, it } from "vitest";
import { DEMO_ASSETS, DEMO_HEAD, DEMO_IMPOSTOR, DEMO_LAUNCHES, DEMO_TIME, demoChain, fakeAddress } from "../testing";
import { ChainReader } from "../src/rpc";
import { type Asset } from "../src/read";
import { MAX_TRACK_WALLETS, readWalletTrades, readWatchlist, TRACK_BLOCKS, walletTopic } from "../src/track";

const URL = "https://rpc.test";
const FIZZ = DEMO_LAUNCHES[0]!;
const MOTE = DEMO_LAUNCHES[3]!;
const GLINT = DEMO_LAUNCHES[2]!;

function setup(rules = {}) {
  const chain = demoChain({ [URL]: rules });
  const reader = new ChainReader({ callEndpoints: [URL], logEndpoints: [URL], fetch: chain.fetch });
  return { chain, reader, cache: new Map<string, Asset>() };
}

const trader = (curve: string, n: number) => fakeAddress(`trader:${curve}:${n}`);

describe("following wallets", () => {
  it("finds the wallets' buys and sells on Pons curves, newest first, with what went in and out", async () => {
    const { reader, cache } = setup();
    // FIZZ's trades go to 15 traders in turn, and every third trade is a sell: trader 1 bought in trades 1 and 16,
    // trader 2 sold in trades 2 and 17.
    const buyer = trader(FIZZ.curve, 1);
    const seller = trader(FIZZ.curve, 2);
    const result = await readWalletTrades(reader, { wallets: [buyer, seller], fromBlock: DEMO_HEAD - TRACK_BLOCKS + 1n, toBlock: DEMO_HEAD, cache });
    expect(result.trades.map((trade) => [trade.side, trade.wallet])).toEqual([
      ["sell", seller],
      ["buy", buyer],
      ["sell", seller],
      ["buy", buyer],
    ]);
    expect(result.trades.every((trade) => trade.token === FIZZ.token && trade.symbol === "FIZZ" && trade.pair.symbol === "ETH" && trade.via === null)).toBe(true);
    const [sell, buy] = result.trades;
    expect(buy!.amountIn).toBe(20_000_000_000_000_000n + 16n * 1_000_000_000_000_000n);
    expect(buy!.amountOut).toBe(1_000_000n * 10n ** 18n);
    expect(sell!.amountIn).toBe(1_000_000n * 10n ** 18n);
    // A sell's quoteOut is after the fee (1% in the fake chain) and tax.
    const quote = 20_000_000_000_000_000n + 17n * 1_000_000_000_000_000n;
    expect(sell!.amountOut).toBe(quote - quote / 100n);
    expect(sell!.block > buy!.block).toBe(true);
    expect(buy!.timestamp).not.toBeNull();
    expect(result.read?.block).toBe(DEMO_HEAD);
    expect(result.dropped).toBe(0);
  });

  it("asks without an address, for the wallets as sender and as recipient", async () => {
    const { chain, reader, cache } = setup();
    const wallets = [trader(FIZZ.curve, 0), trader(MOTE.curve, 1)];
    const result = await readWalletTrades(reader, { wallets, fromBlock: DEMO_HEAD - TRACK_BLOCKS + 1n, toBlock: DEMO_HEAD, cache });
    expect(new Set(result.trades.map((trade) => trade.symbol))).toEqual(new Set(["FIZZ", "MOTE"]));
    const queries = chain.log.filter((entry) => entry.method === "eth_getLogs").map((entry) => entry.params[0] as { address?: unknown; topics: unknown[] });
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.address === undefined)).toBe(true);
    expect(queries[0]!.topics[1]).toEqual(wallets.map(walletTopic));
    expect(queries[1]!.topics[1]).toBeNull();
    expect(queries[1]!.topics[2]).toEqual(wallets.map(walletTopic));
  });

  it("leaves out events from a contract that only pretends to be a curve", async () => {
    const { reader, cache } = setup();
    const result = await readWalletTrades(reader, { wallets: [trader(DEMO_IMPOSTOR.curve, 0)], fromBlock: DEMO_HEAD - TRACK_BLOCKS + 1n, toBlock: DEMO_HEAD, cache });
    expect(result.trades).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it("reads nothing for no wallet, and keeps to the wallet limit", async () => {
    const { chain, reader, cache } = setup();
    const none = await readWalletTrades(reader, { wallets: [], fromBlock: 1n, toBlock: DEMO_HEAD, cache });
    expect(none.trades).toEqual([]);
    expect(chain.log).toHaveLength(0);
    const many = Array.from({ length: MAX_TRACK_WALLETS + 5 }, (_, i) => fakeAddress(`many:${i}`));
    await readWalletTrades(reader, { wallets: many, fromBlock: DEMO_HEAD - 100n, toBlock: DEMO_HEAD, cache });
    const query = chain.log.find((entry) => entry.method === "eth_getLogs")!.params[0] as { topics: unknown[] };
    expect(query.topics[1]).toHaveLength(MAX_TRACK_WALLETS);
  });

  it("finds trades older than the window only when the window reaches them", async () => {
    const { reader, cache } = setup();
    // GLINT's four trades are 40,000 blocks back: outside the 30,000 a query without an address spans.
    const wallet = trader(GLINT.curve, 0);
    const recent = await readWalletTrades(reader, { wallets: [wallet], fromBlock: DEMO_HEAD - TRACK_BLOCKS + 1n, toBlock: DEMO_HEAD, cache });
    expect(recent.trades).toHaveLength(0);
    const wider = await readWalletTrades(reader, { wallets: [wallet], fromBlock: DEMO_HEAD - 50_000n, toBlock: DEMO_HEAD, cache });
    expect(wider.trades.length).toBeGreaterThan(0);
    expect(wider.trades[0]!.pair.symbol).toBe("USDG");
  });
});

describe("the watchlist", () => {
  it("reads saved launches at one block, and says which are not Pons V2 launches", async () => {
    const { reader, cache } = setup();
    const stranger = fakeAddress("not-a-launch");
    const { items, read } = await readWatchlist(reader, [GLINT.token, DEMO_LAUNCHES[5]!.token, stranger], cache);
    expect(read).toEqual({ block: DEMO_HEAD, timestamp: DEMO_TIME });
    expect(items).toHaveLength(3);
    const [glint, brisk, other] = items;
    expect(glint).toMatchObject({ kind: "v2", symbol: "GLINT", liquidity: 642_900_000n, creatorTaxBps: 200, graduated: false });
    expect(glint!.kind === "v2" && glint!.pair.symbol).toBe(DEMO_ASSETS.usdg.symbol);
    expect(brisk).toMatchObject({ kind: "v2", symbol: "BRISK", phase: "graduated", graduated: true });
    expect(other).toMatchObject({ kind: "none", token: stranger });
  });
});
