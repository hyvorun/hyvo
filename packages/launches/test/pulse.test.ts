import { describe, expect, it } from "vitest";
import { computePulse, twinKey, venueOf } from "../src/pulse";
import { ETH, type Asset, type GraduationEvent, type Launch, type LaunchEvent } from "../src/read";

const USDG: Asset = { address: "0x00000000000000000000000000000000000000bb", symbol: "USDG", name: "Global Dollar", decimals: 6 };
const TSLA: Asset = { address: "0x00000000000000000000000000000000000000cc", symbol: "TSLA", name: "Tesla", decimals: 18 };

const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as const;

function launch(i: number, overrides: Partial<Launch> = {}): Launch {
  return {
    token: address(i),
    curve: address(1000 + i),
    creator: address(2000 + i),
    pair: ETH,
    symbol: `T${i}`,
    name: `Token ${i}`,
    launchedAt: 1_000 + i,
    block: BigInt(100 + i),
    txHash: null,
    creatorTaxBps: 0,
    graduated: false,
    liquidity: 1n,
    graduationThreshold: 100n,
    ...overrides,
  };
}

function graduation(token: `0x${string}`, block: bigint): GraduationEvent {
  return { token, positionId: 1n, tokenAmount: 1n, pairTokenAmount: 1n, block, txHash: "0x01", timestamp: null };
}

function event(i: number, pairToken: `0x${string}`): LaunchEvent {
  return {
    token: address(i),
    curve: address(1000 + i),
    creator: address(2000 + i),
    pairToken,
    launchConfigId: 0n,
    graduationThreshold: 100n,
    block: BigInt(100 + i),
    txHash: "0x02",
    logIndex: 0,
    timestamp: null,
  };
}

describe("the pulse", () => {
  const launches = [
    launch(1, { creatorTaxBps: 0 }),
    launch(2, { creatorTaxBps: 100, pair: USDG }),
    launch(3, { creatorTaxBps: 100, symbol: "PEPE", graduated: true }),
    launch(4, { creatorTaxBps: 1000, symbol: "$pepe", name: "Pepe" }),
    launch(5, { creatorTaxBps: null, symbol: "Pepe ", name: "pepe", pair: TSLA }),
    launch(6, { creatorTaxBps: 250, graduated: true }),
    launch(7, { creatorTaxBps: 0, graduated: null }),
  ];
  const graduations = [graduation(address(3), 140n), graduation(address(99), 150n), graduation(address(98), 10n)];

  it("counts launches by pair asset, most first, and where each trades", () => {
    const pulse = computePulse({ fromBlock: 100n, toBlock: 200n, launches, graduations });
    expect(pulse.launches).toBe(7);
    expect(pulse.pairCount).toBe(3);
    expect(pulse.pairs.map((pair) => [pair.pair?.symbol, pair.launches])).toEqual([
      ["ETH", 5],
      // A tie goes to the lower address.
      ["USDG", 1],
      ["TSLA", 1],
    ]);
    // Launch 3 has its pool; launch 6 left its curve with no pool in these blocks; launch 7 was not read.
    expect(pulse.pairs[0]!.venues).toEqual({ curve: 2, pool: 1, between: 1, unknown: 1 });
    expect(pulse.detail?.venues).toEqual({ curve: 4, pool: 1, between: 1, unknown: 1 });
  });

  it("counts only the pools created in its blocks, and which of them launched there too", () => {
    const pulse = computePulse({ fromBlock: 100n, toBlock: 200n, launches, graduations });
    expect(pulse.graduated).toBe(2);
    expect(pulse.graduatedHere).toBe(1);
  });

  it("spreads the creator taxes as set, lowest rate first", () => {
    const detail = computePulse({ fromBlock: 100n, toBlock: 200n, launches, graduations }).detail!;
    expect(detail.rates).toEqual([
      { bps: 0, launches: 2 },
      { bps: 100, launches: 2 },
      { bps: 250, launches: 1 },
      { bps: 1000, launches: 1 },
    ]);
    expect(detail.rateUnknown).toBe(1);
    expect(detail.rateKnown).toBe(6);
    expect(detail.taxed).toBe(4);
    expect(detail.otherRates).toEqual({ rates: 0, launches: 0 });
  });

  it("folds the least common rates and pair assets", () => {
    const many = Array.from({ length: 12 }, (_, i) => launch(i, { creatorTaxBps: i < 4 ? 0 : i * 10 }));
    const pulse = computePulse({ fromBlock: 0n, toBlock: 1_000n, launches: many, graduations: [], maxRates: 3, maxPairs: 1 });
    expect(pulse.detail!.rates[0]).toEqual({ bps: 0, launches: 4 });
    expect(pulse.detail!.rates).toHaveLength(3);
    expect(pulse.detail!.otherRates).toEqual({ rates: 6, launches: 6 });
    expect(pulse.otherPairs).toEqual({ pairs: 0, launches: 0 });
  });

  it("groups launches that share a symbol or a name, ignoring case, spaces and a leading $", () => {
    const detail = computePulse({ fromBlock: 100n, toBlock: 200n, launches, graduations }).detail!;
    expect(detail.sameSymbol).toHaveLength(1);
    expect(detail.sameSymbol[0]!.launches.map((item) => item.token)).toEqual([address(5), address(4), address(3)]);
    expect(detail.sameSymbol[0]!.label).toBe("Pepe ");
    expect(detail.sameName.map((group) => group.launches.length)).toEqual([2]);
    expect(detail.twinned).toBe(3);
    expect(twinKey("  ")).toBeNull();
    expect(twinKey("$ABC")).toBe(twinKey("abc"));
  });

  it("counts pending launches by pair asset and holds the detail until every curve is read", () => {
    const pulse = computePulse({
      fromBlock: 100n,
      toBlock: 200n,
      launches: launches.slice(0, 2),
      pending: [event(8, USDG.address), event(9, "0x00000000000000000000000000000000000000dd"), event(1, ETH.address)],
      graduations,
      assets: new Map([[USDG.address, USDG]]),
    });
    // Launch 1 is both read and pending: it counts once.
    expect(pulse.launches).toBe(4);
    expect(pulse.pairs.map((pair) => [pair.pair?.symbol ?? pair.address, pair.launches, pair.venues])).toEqual([
      ["USDG", 2, null],
      ["ETH", 1, null],
      ["0x00000000000000000000000000000000000000dd", 1, null],
    ]);
    expect(pulse.detail).toBeNull();
  });

  it("leaves out launches outside its blocks", () => {
    const pulse = computePulse({ fromBlock: 104n, toBlock: 105n, launches, graduations: [] });
    expect(pulse.launches).toBe(2);
  });

  it("names a launch's venue from its own facts", () => {
    expect(venueOf(launch(1), new Set())).toBe("curve");
    expect(venueOf(launch(1, { graduated: true }), new Set([address(1)]))).toBe("pool");
    expect(venueOf(launch(1, { graduated: null }), new Set())).toBe("unknown");
  });
});
