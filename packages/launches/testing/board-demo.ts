/**
 * The demo Pons world of demo.ts with what Hyvo Board reads on top: balances of launch tokens, and buys in
 * FIZZ's launch second. Kept apart from demoChain so the Launches tests' counts stay as they are.
 */
import { DEMO_ASSETS, DEMO_EARLIER, DEMO_HEAD, DEMO_IMPOSTOR, DEMO_LAUNCHES, DEMO_OLDER, DEMO_PACE, DEMO_TIME, DEMO_V1, demoTrades } from "./demo";
import { FakeChain, fakeAddress, type EndpointRules, type FakeBalance, type FakeTrade } from "./fake-chain";

const MILLION = 1_000_000n * 10n ** 18n;
const FIZZ = DEMO_LAUNCHES[0]!;
const DRIP = DEMO_LAUNCHES[1]!;
const BRISK = DEMO_LAUNCHES[5]!;

/** Two wallets that bought in FIZZ's launch second, one that bought a few seconds later. */
export const BOARD_SNIPERS = [fakeAddress("board:sniper:1"), fakeAddress("board:sniper:2")] as const;
export const BOARD_LATE_BUYER = fakeAddress("board:late");

/** FIZZ: the creator's wallet holds 62%, the curve 20%, the two first-second buyers 12% and 6%. */
export const BOARD_BALANCES: FakeBalance[] = [
  { token: FIZZ.token, holder: FIZZ.creator, amount: 620n * MILLION },
  { token: FIZZ.token, holder: FIZZ.curve, amount: 200n * MILLION },
  { token: FIZZ.token, holder: BOARD_SNIPERS[0], amount: 120n * MILLION },
  { token: FIZZ.token, holder: BOARD_SNIPERS[1], amount: 60n * MILLION },
  { token: FIZZ.token, holder: BOARD_LATE_BUYER, amount: 30n * MILLION },
  { token: DRIP.token, holder: DRIP.creator, amount: 30n * MILLION },
  { token: DRIP.token, holder: DRIP.curve, amount: 940n * MILLION },
  { token: BRISK.token, holder: BRISK.creator, amount: 10n * MILLION },
];

function buy(block: bigint, trader: `0x${string}`): FakeTrade {
  return { curve: FIZZ.curve, side: "buy", trader, quote: 5_000_000_000_000_000n, tokens: 60n * MILLION, block };
}

/** The creator's own buy and two others in the launch block's second (its block and the next four), and one later. */
export function boardTrades(): FakeTrade[] {
  return [buy(FIZZ.block, FIZZ.creator), buy(FIZZ.block + 1n, BOARD_SNIPERS[0]), buy(FIZZ.block + 3n, BOARD_SNIPERS[1]), buy(FIZZ.block + 30n, BOARD_LATE_BUYER)];
}

export function boardDemoChain(endpoints: Record<string, EndpointRules> = {}): FakeChain {
  return new FakeChain({
    head: DEMO_HEAD,
    headTime: DEMO_TIME,
    blocksPerSecond: DEMO_PACE,
    assets: Object.values(DEMO_ASSETS),
    launches: [...DEMO_LAUNCHES, ...DEMO_EARLIER, DEMO_OLDER],
    trades: [...demoTrades(), ...boardTrades()],
    graduations: [{ token: BRISK.token, block: BRISK.block + 20_000n, pairTokenAmount: 4_200_000_000_000_000_000n, tokenAmount: 285_714_285n * 10n ** 18n }],
    v1: [DEMO_V1],
    impostors: [DEMO_IMPOSTOR],
    tokens: [{ address: DEMO_V1.pairedToken, symbol: "WETH", name: "Wrapped Ether", decimals: 18 }],
    balances: BOARD_BALANCES,
    endpoints,
  });
}
