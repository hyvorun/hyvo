import { describe, expect, it } from "vitest";
import { BURN_ADDRESSES, computeHolderScan, lastBlockOfSecond, readFirstSecondBuyers, readHolderBalances, fractionOf } from "../src/holder-scan";
import { ChainReader } from "../src/rpc";
import { FakeChain, fakeAddress } from "../testing";

const SUPPLY = 10n ** 27n;
const TOKEN = fakeAddress("scan:token");
const CURVE = fakeAddress("scan:curve");
const CREATOR = fakeAddress("scan:creator");
const POOL = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const wallet = (n: number) => fakeAddress(`scan:wallet:${n}`);
const pct = (n: number) => (SUPPLY * BigInt(n)) / 100n;

describe("computeHolderScan", () => {
  it("leaves the curve, the pool and burn addresses out of the top ten, and labels them", () => {
    const listed = [CURVE, POOL, BURN_ADDRESSES[1]!, CREATOR, ...Array.from({ length: 12 }, (_, i) => wallet(i))];
    const balances = new Map<string, bigint>([
      [CURVE.toLowerCase(), pct(40)],
      [POOL.toLowerCase(), pct(20)],
      [BURN_ADDRESSES[1]!.toLowerCase(), pct(5)],
      [CREATOR.toLowerCase(), pct(6)],
      ...Array.from({ length: 12 }, (_, i) => [wallet(i).toLowerCase(), pct(1)] as [string, bigint]),
    ]);
    const scan = computeHolderScan({
      supply: SUPPLY,
      holderCount: 412,
      listed,
      balances,
      creator: CREATOR,
      curve: CURVE,
      poolManager: POOL,
      firstSecondBuyers: [wallet(0), wallet(1), CREATOR, wallet(0)],
    });
    expect(scan.holderCount).toBe(412);
    // The creator (6%) and the nine largest of the twelve 1% wallets.
    expect(scan.top10).toEqual({ wallets: 10, balance: pct(15), share: 0.15 });
    expect(scan.creator).toEqual({ balance: pct(6), share: 0.06 });
    expect(scan.firstSecond).toEqual({ wallets: 3, holding: 3, balance: pct(8), share: 0.08, includesCreator: true, unread: 0 });
    expect(scan.rows[0]).toMatchObject({ address: CURVE, share: 0.4, labels: ["curve"] });
    expect(scan.rows[1]).toMatchObject({ labels: ["pool"] });
    expect(scan.rows[2]).toMatchObject({ address: CREATOR, labels: ["creator", "first-second"] });
    expect(scan.rows[3]).toMatchObject({ labels: ["burn"] });
    expect(scan.rows.find((row) => row.address === wallet(1))?.labels).toEqual(["first-second"]);
    expect(scan.rows).toHaveLength(16);
  });

  it("re-ranks the index's list by the balances read on-chain and drops wallets that hold nothing now", () => {
    const scan = computeHolderScan({
      supply: SUPPLY,
      holderCount: 3,
      listed: [wallet(1), wallet(2), wallet(3)],
      balances: new Map([
        [wallet(1).toLowerCase(), pct(1)],
        [wallet(2).toLowerCase(), pct(3)],
        [wallet(3).toLowerCase(), 0n],
      ]),
      creator: CREATOR,
      curve: CURVE,
      poolManager: null,
      firstSecondBuyers: [],
    });
    expect(scan.rows.map((row) => row.address)).toEqual([wallet(2), wallet(1)]);
    expect(scan.top10?.share).toBe(0.04);
    expect(scan.creator).toEqual({ balance: null, share: null });
    expect(scan.firstSecond).toEqual({ wallets: 0, holding: 0, balance: 0n, share: 0, includesCreator: false, unread: 0 });
  });

  it("says what was not read instead of guessing", () => {
    const scan = computeHolderScan({
      supply: null,
      holderCount: null,
      listed: null,
      balances: new Map([[CREATOR.toLowerCase(), pct(2)]]),
      creator: CREATOR,
      curve: CURVE,
      poolManager: null,
      firstSecondBuyers: [wallet(1)],
    });
    expect(scan.top10).toBeNull();
    expect(scan.rows).toEqual([]);
    expect(scan.creator).toEqual({ balance: pct(2), share: null });
    expect(scan.firstSecond).toEqual({ wallets: 1, holding: 0, balance: 0n, share: null, includesCreator: false, unread: 1 });
  });

  it("computes a share to a millionth", () => {
    expect(fractionOf(1n, 3n)).toBe(0.333333);
    expect(fractionOf(5n, 0n)).toBeNull();
    expect(fractionOf(null, 10n)).toBeNull();
  });
});

describe("reading a scan from the chain", () => {
  const launchBlock = 1_000n;
  const pace = 10;
  // Block 1,000 is at second 100 here: blocks 1,000 to 1,009 share it.
  const chain = new FakeChain({
    head: 2_000n,
    headTime: 200,
    blocksPerSecond: pace,
    launches: [
      {
        token: TOKEN,
        curve: CURVE,
        creator: CREATOR,
        pairToken: "0x0000000000000000000000000000000000000000",
        symbol: "SCAN",
        name: "Scan",
        block: launchBlock,
        launchedAt: 100,
        graduationThreshold: 10n ** 18n,
        liquidity: 0n,
      },
    ],
    trades: [
      { curve: CURVE, side: "buy", trader: wallet(1), quote: 10n ** 16n, tokens: pct(2), block: 1_000n },
      { curve: CURVE, side: "buy", trader: wallet(2), quote: 10n ** 16n, tokens: pct(1), block: 1_004n },
      { curve: CURVE, side: "sell", trader: wallet(3), quote: 10n ** 16n, tokens: pct(1), block: 1_005n },
      // The next second.
      { curve: CURVE, side: "buy", trader: wallet(4), quote: 10n ** 16n, tokens: pct(1), block: 1_012n },
    ],
    balances: { [TOKEN]: { [wallet(1)]: pct(2), [CREATOR]: pct(3), [CURVE]: pct(50) } },
  });
  const reader = new ChainReader({ callEndpoints: ["http://rpc.test"], logEndpoints: ["http://rpc.test"], fetch: chain.fetch });

  it("finds the last block of the launch second", async () => {
    expect(chain.timeOf(1_000n)).toBe(100);
    const last = await lastBlockOfSecond(reader, launchBlock, 100);
    expect(chain.timeOf(last)).toBe(100);
    expect(chain.timeOf(last + 1n)).toBe(101);
  });

  it("reads the buyers of the launch second, not its sellers or later buyers", async () => {
    const found = await readFirstSecondBuyers(reader, { curve: CURVE, launchBlock, launchedAt: 100 });
    expect(found.buyers).toEqual([wallet(1), wallet(2)]);
    expect(found.fromBlock).toBe(launchBlock);
  });

  it("reads the supply, the pool manager and each balance at one block", async () => {
    const read = await readHolderBalances(reader, { token: TOKEN, addresses: [wallet(1), wallet(2), CREATOR, CURVE] });
    expect(read.supply).toBe(SUPPLY);
    expect(read.poolManager).toBe(POOL);
    expect(read.balances.get(wallet(1).toLowerCase())).toBe(pct(2));
    expect(read.balances.get(wallet(2).toLowerCase())).toBe(0n);
    expect(read.balances.get(CURVE.toLowerCase())).toBe(pct(50));
    expect(read.read.block).toBe(2_000n);
  });
});
