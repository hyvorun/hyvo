import { describe, expect, it } from "vitest";
import { CHECKS } from "../src/checks/catalog";
import { type DiscoveryA, type DiscoveryB, type DiscoveryC, chooseVenue, parseDiscoveryA } from "../src/checks/pool";
import { ADDRESSES } from "../src/registry/addresses";
import type { Address } from "../src/types";
import { encodeAbiParameters, type AbiParameter } from "viem";

const TOKEN = "0x8EEe67a8aaD993F15b4506975b38c52f6D3ce758" as Address;
const CURVE = "0x4444444444444444444444444444444444444444" as Address;
const PAIR = "0xdb661EC4D1ba1D9ad9D2A6Cd92FcE25a8F08aD25" as Address;
const POOL_A = "0x5555555555555555555555555555555555555555" as Address;
const POOL_B = "0x6666666666666666666666666666666666666666" as Address;
const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function discA(over: Partial<DiscoveryA> = {}): DiscoveryA {
  return {
    ponsV2: null,
    ponsV1: null,
    v2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
    v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    ponsHook: HOOK,
    ponsPoolManager: ADDRESSES.uniswapV4PoolManager.address,
    poolManagerBalance: 0n,
    ...over,
  };
}
const discB = (over: Partial<DiscoveryB> = {}): DiscoveryB => ({ v2Pair: null, v3Pools: [], curveRates: null, ...over });
const discC = (over: Partial<DiscoveryC> = {}): DiscoveryC => ({ v2Reserves: null, v3: [], ...over });
const pons = (phase: number, pairToken: Address = ZERO) => ({
  curve: CURVE,
  launcher: TOKEN,
  pairToken,
  poolFee: 0,
  tickSpacing: 200,
  creatorTaxBps: 100,
  phase,
});

describe("venue discovery", () => {
  it("takes a Pons v2 curve quoted in ETH first", () => {
    const choice = chooseVenue(
      TOKEN,
      18,
      discA({ ponsV2: pons(0) }),
      discB({ v2Pair: PAIR, curveRates: { feeBps: 100, creatorTaxBps: 100, snipeTaxBpsNow: 0 } }),
      discC({ v2Reserves: { weth: 10n ** 18n, token: 10n ** 24n } }),
    );
    expect(choice.venue).toEqual({ kind: "pons-curve", curve: CURVE, curveFeeBps: 100, creatorTaxBps: 100, snipeTaxBpsNow: 0 });
    expect(choice.finding.status).toBe("found");
    expect(choice.finding.evidence).toContain("curve fee 1%, creator tax 1%, snipe tax at this block 0%");
    expect(choice.excluded.map((e) => e.label)).toContain("the Pons curve");
  });

  it("leaves out of the top holders exactly the addresses it found, and says what each is, as the check's description does", () => {
    const choice = chooseVenue(
      TOKEN,
      18,
      discA({ ponsV2: pons(0) }),
      discB({ v2Pair: PAIR, v3Pools: [{ fee: 3000, pool: POOL_A }] }),
      discC({ v2Reserves: { weth: 10n ** 18n, token: 10n ** 24n } }),
    );
    const labels = [...new Set(choice.excluded.map((e) => e.label))];
    expect(labels).toEqual([
      "burn addresses",
      "the Uniswap V4 PoolManager",
      "the Pons curve",
      "the Uniswap V2 pair with WETH",
      "the Uniswap V3 pools with WETH",
    ]);
    // Only pools with WETH are discovered, so what the check looks for says so rather than "pools".
    const looksFor = CHECKS.holders.looksFor;
    for (const words of ["burn addresses", "the Uniswap V4 PoolManager", "Pons curve", "Uniswap V2 pair", "V3 pools with WETH"]) {
      expect(looksFor).toContain(words);
    }
  });

  it("takes a graduated Pons launch's V4 pool with the hook from the factory", () => {
    const choice = chooseVenue(TOKEN, 18, discA({ ponsV2: pons(2) }), discB(), discC());
    expect(choice.venue).toMatchObject({ kind: "pons-v4", hooks: HOOK, fee: 0, tickSpacing: 200, quote: ZERO });
  });

  it("falls back past a Pons curve quoted in USDG, and says so", () => {
    const usdg = ADDRESSES.usdg.address;
    const choice = chooseVenue(
      TOKEN,
      18,
      discA({ ponsV2: pons(0, usdg) }),
      discB({ v2Pair: PAIR }),
      discC({ v2Reserves: { weth: 5n, token: 7n } }),
    );
    expect(choice.venue).toMatchObject({ kind: "v2", pair: PAIR });
    expect(choice.finding.evidence).toContain("also the Pons v2 bonding curve");
    const alone = chooseVenue(TOKEN, 18, discA({ ponsV2: pons(0, usdg) }), discB(), discC());
    expect(alone.venue).toBeNull();
    expect(alone.uncovered).toContain("buys with ETH");
    expect(alone.finding.status).toBe("found");
  });

  it("skips a V2 pair without reserves and takes the V3 pool with the most in-range liquidity", () => {
    const choice = chooseVenue(
      TOKEN,
      18,
      discA(),
      discB({ v2Pair: PAIR, v3Pools: [{ fee: 3000, pool: POOL_A }, { fee: 10000, pool: POOL_B }] }),
      discC({
        v2Reserves: { weth: 0n, token: 0n },
        v3: [
          { fee: 3000, pool: POOL_A, liquidity: 10n, weth: 10n ** 20n },
          { fee: 10000, pool: POOL_B, liquidity: 99n, weth: 1n },
        ],
      }),
    );
    expect(choice.venue).toMatchObject({ kind: "v3", pool: POOL_B, fee: 10000, router: ADDRESSES.uniswapV3SwapRouter02.address });
    expect(choice.finding.evidence).toContain("1% fee tier, in-range liquidity 99");
  });

  it("reports a V4 pool outside Pons as not covered yet", () => {
    const choice = chooseVenue(TOKEN, 18, discA({ poolManagerBalance: 5n * 10n ** 18n }), discB(), discC());
    expect(choice.venue).toBeNull();
    expect(choice.finding.status).toBe("found");
    expect(choice.uncovered).toBe("V4 pools outside Pons are not covered by the exit simulation yet");
  });

  it("names pools that exist but hold nothing to trade against", () => {
    const choice = chooseVenue(
      TOKEN,
      18,
      discA(),
      discB({ v2Pair: PAIR, v3Pools: [{ fee: 10000, pool: POOL_A }] }),
      discC({ v2Reserves: { weth: 0n, token: 0n }, v3: [{ fee: 10000, pool: POOL_A, liquidity: 0n, weth: 0n }] }),
    );
    expect(choice.venue).toBeNull();
    expect(choice.finding.status).toBe("not_found");
    expect(choice.finding.evidence).toContain("the Uniswap V2 pair 0xdb66…aD25 with WETH holds no reserves");
    expect(choice.finding.evidence).toContain("the Uniswap V3 pool 0x5555…5555 (1%) holds no WETH and no in-range liquidity");
    expect(choice.uncovered).toBe("the token's pools hold no liquidity to trade against");
  });

  it("is not found when nothing trades it, and says everywhere it looked", () => {
    const choice = chooseVenue(TOKEN, 18, discA(), discB(), discC());
    expect(choice.venue).toBeNull();
    expect(choice.finding.status).toBe("not_found");
    expect(choice.finding.evidence).toContain("0.01%, 0.05%, 0.3%, 1% fee tiers");
  });
});

describe("parseDiscoveryA", () => {
  it("decodes a Pons v2 launch record and ignores a record that does not exist", () => {
    const params = [
      {
        type: "tuple",
        components: [
          { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
          { type: "uint256" }, { type: "uint24" }, { type: "int24" }, { type: "uint16" }, { type: "bool" }, { type: "uint8" },
          { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" },
        ],
      },
    ] as unknown as AbiParameter[];
    const record = (exists: boolean) =>
      encodeAbiParameters(params, [[TOKEN, CURVE, TOKEN, TOKEN, ZERO, 1n, 0, 200, 289, false, 0, 0n, 0n, 0n, exists]] as never);
    const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
    const answers = [record(true), null, word(PAIR), word(POOL_A), word(HOOK), word(ADDRESSES.uniswapV4PoolManager.address), null];
    const a = parseDiscoveryA(answers);
    expect(a.ponsV2).toEqual({ curve: CURVE, launcher: TOKEN, pairToken: ZERO, poolFee: 0, tickSpacing: 200, creatorTaxBps: 289, phase: 0 });
    expect(a.ponsHook).toBe(HOOK);
    expect(a.poolManagerBalance).toBeNull();
    expect(parseDiscoveryA([record(false), null, null, null, null, null, null]).ponsV2).toBeNull();
  });
});
