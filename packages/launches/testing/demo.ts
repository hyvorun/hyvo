/**
 * A small, made-up Pons world for tests: fictional tokens on the real contract layout, launched over
 * the last few hours, paired with ETH and three test assets, with trades, a graduation, a token from
 * Pons V1 and a contract that only pretends to be a curve.
 */
import { NATIVE } from "../src/pons";
import { FakeChain, fakeAddress, type EndpointRules, type FakeLaunch, type FakeTrade } from "./fake-chain";

export const DEMO_HEAD = 109_867_700n;
/** 2026-11-09T07:01:46Z. */
export const DEMO_TIME = 1_794_207_706;
export const DEMO_PACE = 9.6;

export const DEMO_ASSETS = {
  usdg: { address: fakeAddress("asset:USDG"), symbol: "USDG", name: "Global Dollar", decimals: 6 },
  nvda: { address: fakeAddress("asset:NVDA"), symbol: "NVDA", name: "NVIDIA • Robinhood Token", decimals: 18 },
  tsla: { address: fakeAddress("asset:TSLA"), symbol: "TSLA", name: "Tesla • Robinhood Token", decimals: 18 },
} as const;

const ETH_THRESHOLD = 4_200_000_000_000_000_000n; // 4.2 ETH
const USDG_THRESHOLD = 8_090_000_000n; // 8,090 USDG
const NVDA_THRESHOLD = 41_600_000_000_000_000_000n; // 41.6 NVDA

function launch(index: number, overrides: Partial<FakeLaunch> & { symbol: string; ageMinutes: number }): FakeLaunch {
  const block = DEMO_HEAD - BigInt(Math.round(overrides.ageMinutes * 60 * DEMO_PACE));
  const { ageMinutes, ...rest } = overrides;
  return {
    token: fakeAddress(`token:${index}`),
    curve: fakeAddress(`curve:${index}`),
    creator: fakeAddress(`creator:${index}`),
    pairToken: NATIVE,
    name: `${overrides.symbol} Token`,
    block,
    launchedAt: Math.round(DEMO_TIME - ageMinutes * 60),
    graduationThreshold: ETH_THRESHOLD,
    liquidity: 10n ** 16n,
    ...rest,
  };
}

export const DEMO_LAUNCHES: FakeLaunch[] = [
  launch(1, { symbol: "FIZZ", name: "Fizz", ageMinutes: 3, liquidity: 59_940_000_000_000_000n, creatorTaxBps: 0 }),
  launch(2, { symbol: "DRIP", name: "Drip", ageMinutes: 8, liquidity: 1_875_000_000_000_000n, creatorTaxBps: 100, pairToken: DEMO_ASSETS.usdg.address, graduationThreshold: USDG_THRESHOLD }),
  launch(3, { symbol: "GLINT", name: "Glint", ageMinutes: 19, liquidity: 642_900_000n, creatorTaxBps: 200, pairToken: DEMO_ASSETS.usdg.address, graduationThreshold: USDG_THRESHOLD }),
  launch(4, { symbol: "MOTE", name: "Mote", ageMinutes: 25, liquidity: 2_520_000_000_000_000_000n, creatorTaxBps: 0 }),
  launch(5, { symbol: "PLUME", name: "Plume", ageMinutes: 41, liquidity: 4_330_000_000_000_000_000n, creatorTaxBps: 50, pairToken: DEMO_ASSETS.nvda.address, graduationThreshold: NVDA_THRESHOLD }),
  launch(6, { symbol: "BRISK", name: "Brisk", ageMinutes: 70, liquidity: 0n, creatorTaxBps: 1000, phase: 2 }),
  launch(7, { symbol: "TALLOW", name: "Tallow", ageMinutes: 95, liquidity: 380_000_000_000_000_000n, creatorTaxBps: 0, pairToken: DEMO_ASSETS.tsla.address, graduationThreshold: NVDA_THRESHOLD }),
  launch(8, { symbol: "QUILL", name: "Quill", ageMinutes: 150, liquidity: 120_000_000_000_000_000n, creatorTaxBps: 0 }),
  launch(9, { symbol: "OSPREY", name: "Osprey", ageMinutes: 230, liquidity: 3_100_000_000_000_000_000n, creatorTaxBps: 300 }),
  launch(10, { symbol: "WREN", name: "Wren", ageMinutes: 320, liquidity: 45_000_000_000_000_000n, creatorTaxBps: 0 }),
];

/** A curve launched a day ago, outside a 6-hour window, that still trades. */
export const DEMO_OLDER = launch(11, { symbol: "EMBER", name: "Ember", ageMinutes: 26 * 60, liquidity: 1_900_000_000_000_000_000n, creatorTaxBps: 100 });

export const DEMO_IMPOSTOR = { curve: fakeAddress("impostor"), claimsToken: DEMO_LAUNCHES[0]!.token };

export const DEMO_V1 = { token: fakeAddress("v1:token"), creator: fakeAddress("v1:creator"), pairedToken: fakeAddress("asset:WETH"), symbol: "OLDIE", name: "Oldie" };

function trades(curve: `0x${string}`, count: number, startBlock: bigint, people: number): FakeTrade[] {
  return Array.from({ length: count }, (_, i) => ({
    curve,
    side: i % 3 === 2 ? "sell" : "buy",
    trader: fakeAddress(`trader:${curve}:${i % people}`),
    quote: 20_000_000_000_000_000n + BigInt(i) * 1_000_000_000_000_000n,
    tokens: 1_000_000n * 10n ** 18n,
    tax: 0n,
    block: startBlock + BigInt(i * 300),
  }));
}

export function demoTrades(): FakeTrade[] {
  return [
    ...trades(DEMO_LAUNCHES[0]!.curve, 27, DEMO_HEAD - 8_000n, 15),
    ...trades(DEMO_LAUNCHES[3]!.curve, 12, DEMO_HEAD - 9_000n, 9),
    ...trades(DEMO_OLDER.curve, 18, DEMO_HEAD - 9_500n, 11),
    // The impostor's events look like trades and must not count.
    ...trades(DEMO_IMPOSTOR.curve, 40, DEMO_HEAD - 9_900n, 2),
    // An older trade on GLINT, outside a 15-minute window.
    ...trades(DEMO_LAUNCHES[2]!.curve, 4, DEMO_HEAD - 40_000n, 3),
  ];
}

export function demoChain(endpoints: Record<string, EndpointRules> = {}): FakeChain {
  return new FakeChain({
    head: DEMO_HEAD,
    headTime: DEMO_TIME,
    blocksPerSecond: DEMO_PACE,
    assets: Object.values(DEMO_ASSETS),
    launches: [...DEMO_LAUNCHES, DEMO_OLDER],
    trades: demoTrades(),
    graduations: [{ token: DEMO_LAUNCHES[5]!.token, block: DEMO_LAUNCHES[5]!.block + 20_000n, pairTokenAmount: ETH_THRESHOLD, tokenAmount: 285_714_285n * 10n ** 18n }],
    v1: [DEMO_V1],
    impostors: [DEMO_IMPOSTOR],
    tokens: [{ address: DEMO_V1.pairedToken, symbol: "WETH", name: "Wrapped Ether", decimals: 18 }],
    endpoints,
  });
}
