import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  boardColumns,
  boardFlags,
  CREATOR_SHARE_FLAG,
  CREATOR_TAX_FLAG_BPS,
  curveProgress,
  estimateTime,
  FIRST_SECOND_SHARE_FLAG,
  firstSecondWallets,
  nextDelay,
  nextScan,
  pruneTrades,
  shareOf,
  shownCards,
  windowTrades,
  type BoardLaunch,
} from "../src/board";
import { readFacts, readLaunchBuys, readRecords, readTradeLogs, verifyCurves } from "../src/board-read";
import { ETH, type Trade } from "../src/read";
import { ChainReader } from "../src/rpc";
import { BOARD_SNIPERS, boardDemoChain, DEMO_HEAD, DEMO_IMPOSTOR, DEMO_LAUNCHES, DEMO_OLDER, fakeAddress } from "../testing";

const NOW = 1_794_207_706;
const SUPPLY = 10n ** 27n;

function launch(label: string, overrides: Partial<BoardLaunch> = {}): BoardLaunch {
  return {
    token: fakeAddress(`token:${label}`),
    curve: fakeAddress(`curve:${label}`),
    creator: fakeAddress(`creator:${label}`),
    pair: ETH,
    symbol: label,
    name: `${label} Token`,
    block: 1_000n,
    launchedAt: NOW - 600,
    graduationThreshold: 4_200_000_000_000_000_000n,
    creatorTaxBps: 0,
    graduated: false,
    liquidity: 0n,
    graduatedAt: null,
    supply: SUPPLY,
    creatorBalance: 0n,
    curveBalance: SUPPLY,
    firstSecond: null,
    ...overrides,
  };
}

function trade(curve: Address, side: "buy" | "sell", trader: string, overrides: Partial<Trade> = {}): Trade {
  return {
    curve,
    side,
    trader: fakeAddress(trader),
    quote: 10n ** 16n,
    tokens: 10n ** 24n,
    fee: 0n,
    tax: 0n,
    block: 2_000n,
    txHash: "0x01",
    logIndex: 0,
    timestamp: NOW - 30,
    ...overrides,
  };
}

describe("curveProgress and shareOf", () => {
  it("are the curve's ratio, done once graduated, and a share of the launch supply", () => {
    expect(curveProgress({ graduated: false, liquidity: 2_100_000_000_000_000_000n, graduationThreshold: 4_200_000_000_000_000_000n })).toBe(0.5);
    expect(curveProgress({ graduated: true, liquidity: 0n, graduationThreshold: 4_200_000_000_000_000_000n })).toBe(1);
    expect(curveProgress({ graduated: null, liquidity: null, graduationThreshold: 1n })).toBeNull();
    expect(shareOf(620_000_000n * 10n ** 18n, SUPPLY)).toBe(0.62);
    expect(shareOf(0n, SUPPLY)).toBe(0);
    expect(shareOf(SUPPLY * 2n, SUPPLY)).toBe(1);
    expect(shareOf(null, SUPPLY)).toBeNull();
    expect(shareOf(1n, 0n)).toBeNull();
  });
});

describe("estimateTime", () => {
  it("counts back from the head at the chain's pace", () => {
    expect(estimateTime(1_000n - 96n, { block: 1_000n, timestamp: NOW }, 9.6)).toBe(NOW - 10);
  });
});

describe("windowTrades", () => {
  it("counts buys, sells, volume and distinct buyers per curve from a time on", () => {
    const a = fakeAddress("curve:a");
    const b = fakeAddress("curve:b");
    const trades = [
      trade(a, "buy", "w1"),
      trade(a, "buy", "w1"),
      trade(a, "buy", "w2"),
      trade(a, "sell", "w3", { quote: 5n }),
      trade(b, "buy", "w1", { timestamp: NOW - 400 }),
      trade(b, "sell", "w4", { timestamp: null }),
    ];
    const rows = windowTrades(trades, NOW - 300);
    expect(rows.get(a.toLowerCase())).toEqual({ buys: 3, sells: 1, volume: 3n * 10n ** 16n + 5n, buyers: 2 });
    // b's trades are older than the window, or have no time.
    expect(rows.has(b.toLowerCase())).toBe(false);
    expect(pruneTrades(trades, NOW - 300)).toHaveLength(4);
  });
});

describe("firstSecondWallets", () => {
  it("keeps the buys of the launch second on the launch's own curve, the creator's left out", () => {
    const l = launch("FIZZ", { launchedAt: NOW - 100 });
    const trades = [
      trade(l.curve, "buy", "sniper-1", { timestamp: NOW - 100, block: 10n, logIndex: 2 }),
      trade(l.curve, "buy", "sniper-2", { timestamp: NOW - 100, block: 10n, logIndex: 1 }),
      trade(l.curve, "buy", "sniper-1", { timestamp: NOW - 100, block: 11n }),
      { ...trade(l.curve, "buy", "x", { timestamp: NOW - 100 }), trader: l.creator },
      trade(l.curve, "sell", "seller", { timestamp: NOW - 100 }),
      trade(l.curve, "buy", "late", { timestamp: NOW - 99 }),
      trade(fakeAddress("curve:other"), "buy", "elsewhere", { timestamp: NOW - 100 }),
    ];
    expect(firstSecondWallets(trades, { curve: l.curve, token: l.token, creator: l.creator, launchedAt: NOW - 100 })).toEqual([
      fakeAddress("sniper-2"),
      fakeAddress("sniper-1"),
    ]);
    expect(firstSecondWallets(trades, { curve: l.curve, token: l.token, creator: l.creator, launchedAt: NOW - 100 }, 1)).toEqual([fakeAddress("sniper-2")]);
  });
});

describe("boardColumns", () => {
  const fresh = launch("FRESH", { launchedAt: NOW - 60, block: 900n });
  const fresher = launch("FRESHER", { launchedAt: NOW - 20, block: 990n });
  const old = launch("OLD", { launchedAt: NOW - 3 * 3600 });
  const close = launch("CLOSE", { launchedAt: NOW - 5 * 3600, liquidity: 3_000_000_000_000_000_000n });
  const closer = launch("CLOSER", { launchedAt: NOW - 120, liquidity: 4_000_000_000_000_000_000n });
  const half = launch("HALF", { launchedAt: NOW - 7200, liquidity: 2_100_000_000_000_000_000n });
  const grad = launch("GRAD", { graduated: true, liquidity: 0n, graduatedAt: NOW - 600 });
  const gradNewer = launch("GRADNEW", { graduated: true, liquidity: 0n, graduatedAt: NOW - 60, launchedAt: NOW - 300 });
  const gradOld = launch("GRADOLD", { graduated: true, liquidity: 0n, graduatedAt: NOW - 25 * 3600 });
  const swept = launch("SWEPT", { graduated: true, liquidity: 0n, launchedAt: NOW - 100 });
  const unread = launch("UNREAD", { graduated: null, liquidity: null, launchedAt: NOW - 30 });
  const columns = boardColumns([old, fresh, close, grad, closer, fresher, half, gradNewer, gradOld, swept, unread, fresh], NOW);
  const symbols = (list: BoardLaunch[]) => list.map((item) => item.symbol);

  it("puts each launch in the furthest column it has reached, once", () => {
    expect(symbols(columns.new)).toEqual(["FRESHER", "UNREAD", "FRESH"]);
    expect(symbols(columns.stretch)).toEqual(["CLOSER", "CLOSE", "HALF"]);
    expect(symbols(columns.graduated)).toEqual(["GRADNEW", "GRAD"]);
  });

  it("leaves out launches older than an hour below half way, pools older than a day and curves that stopped without a pool read", () => {
    const all = [...columns.new, ...columns.stretch, ...columns.graduated].map((item) => item.symbol);
    expect(all).not.toContain("OLD");
    expect(all).not.toContain("GRADOLD");
    expect(all).not.toContain("SWEPT");
  });

  it("shows the first cards of each column", () => {
    expect(symbols(shownCards(columns, 1))).toEqual(["FRESHER", "CLOSER", "GRADNEW"]);
  });
});

describe("boardFlags", () => {
  it("state each fact past its threshold with its number, and nothing else", () => {
    const l = launch("FLAG", {
      creatorBalance: 620_000_000n * 10n ** 18n,
      firstSecond: { wallets: 4, balance: 180_000_000n * 10n ** 18n },
      creatorTaxBps: 1000,
    });
    expect(boardFlags(l)).toEqual([
      { id: "creator", text: "Creator holds 62%" },
      { id: "first-second", text: "First-second buyers hold 18%" },
      { id: "tax", text: "Creator tax 10%" },
    ]);
  });

  it("stay quiet under the thresholds and when a figure is not read", () => {
    const below = launch("QUIET", {
      creatorBalance: (SUPPLY * BigInt(Math.round(CREATOR_SHARE_FLAG * 1000) - 1)) / 1000n,
      firstSecond: { wallets: 2, balance: (SUPPLY * BigInt(Math.round(FIRST_SECOND_SHARE_FLAG * 1000) - 1)) / 1000n },
      creatorTaxBps: CREATOR_TAX_FLAG_BPS - 1,
    });
    expect(boardFlags(below)).toEqual([]);
    expect(boardFlags(launch("NULL", { creatorBalance: null, firstSecond: { wallets: 3, balance: null }, creatorTaxBps: null }))).toEqual([]);
  });

  it("never use words that rate a token", () => {
    const text = boardFlags(launch("ALL", { creatorBalance: SUPPLY, firstSecond: { wallets: 1, balance: SUPPLY }, creatorTaxBps: 1000 }))
      .map((flag) => flag.text)
      .join(" ");
    expect(text).not.toMatch(/\b(safe|scam|rug|honeypot|legit|risk|risky|dump|pump|moon|gem|red flag|verdict|score|buy|sell)\b/i);
  });
});

describe("nextScan and nextDelay", () => {
  it("read on from the last block, skip when nothing is new and start over after a long gap", () => {
    expect(nextScan(100n, 150n, 1_000n)).toEqual({ from: 101n, to: 150n });
    expect(nextScan(150n, 150n, 1_000n)).toBeNull();
    expect(nextScan(100n, 5_000n, 1_000n)).toBe("restart");
  });

  it("back off after failures, up to a cap", () => {
    expect(nextDelay(15_000, 0)).toBe(15_000);
    expect(nextDelay(15_000, 1)).toBe(30_000);
    expect(nextDelay(15_000, 2)).toBe(60_000);
    expect(nextDelay(15_000, 9)).toBe(BACKOFF_MAX_MS);
  });
});

describe("reading the board's facts from the chain", () => {
  const URL = "https://rpc.test";
  const setup = (rules = {}) => {
    const chain = boardDemoChain({ [URL]: rules });
    return { chain, reader: new ChainReader({ callEndpoints: [URL], logEndpoints: [URL], fetch: chain.fetch }) };
  };
  const FIZZ = DEMO_LAUNCHES[0]!;
  const entry = { token: FIZZ.token, curve: FIZZ.curve, creator: FIZZ.creator, pairToken: FIZZ.pairToken, graduationThreshold: FIZZ.graduationThreshold, block: FIZZ.block, timestamp: null };

  it("finds the wallets of the launch second, the creator's left out, and reads every share at one block", async () => {
    // Without times on the logs, the block headers give them.
    const { reader } = setup({ timestamps: false });
    const buys = await readLaunchBuys(reader, entry, DEMO_HEAD);
    expect(buys.every((item) => item.timestamp !== null)).toBe(true);
    const wallets = firstSecondWallets(buys, { curve: FIZZ.curve, token: FIZZ.token, creator: FIZZ.creator, launchedAt: FIZZ.launchedAt });
    expect(wallets).toEqual([...BOARD_SNIPERS]);
    const { facts, read } = await readFacts(reader, [{ entry, statics: true, balances: true, wallets }]);
    expect(read.block).toBe(DEMO_HEAD);
    const row = facts.get(FIZZ.token.toLowerCase())!;
    expect(row).toMatchObject({ symbol: "FIZZ", launchedAt: FIZZ.launchedAt, creatorTaxBps: 0, supply: SUPPLY, graduated: false, liquidity: FIZZ.liquidity });
    expect(shareOf(row.creatorBalance!, row.supply!)).toBe(0.62);
    expect(shareOf(row.curveBalance!, row.supply!)).toBe(0.2);
    expect(shareOf(row.walletsBalance!, row.supply!)).toBe(0.18);
  });

  it("finds launches through the factory's record, and only real curves among emitters", async () => {
    const { reader } = setup();
    const records = await readRecords(reader, [DEMO_OLDER.token, fakeAddress("nobody")]);
    expect(records.map((record) => record.curve)).toEqual([DEMO_OLDER.curve]);
    expect(records[0]!.block).toBeNull();
    const verified = await verifyCurves(reader, [DEMO_OLDER.curve, DEMO_IMPOSTOR.curve]);
    expect(verified.map((record) => record.token)).toEqual([DEMO_OLDER.token]);
  });

  it("counts every curve's trades, or the given curves' when no endpoint answers without an address", async () => {
    const everyCurve = await readTradeLogs(setup().reader, DEMO_HEAD - 2_880n, DEMO_HEAD, []);
    expect(everyCurve.everyCurve).toBe(true);
    expect(everyCurve.trades.length).toBeGreaterThan(0);
    const fallback = await readTradeLogs(setup({ needsAddress: true }).reader, DEMO_HEAD - 2_880n, DEMO_HEAD, [FIZZ.curve]);
    expect(fallback.everyCurve).toBe(false);
    expect(new Set(fallback.trades.map((item) => item.curve.toLowerCase()))).toEqual(new Set([FIZZ.curve.toLowerCase()]));
  });
});
