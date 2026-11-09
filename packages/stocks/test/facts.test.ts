import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { STOCK_REGISTRY } from "../src/contracts";
import { movementFacts, multiplierFacts, multiplierRatio, priceFacts, verdictOf } from "../src/facts";
import type { FeedListing } from "../src/feeds";
import type { FeedReading, StockReading, TokenFacts } from "../src/read";

const ADDRESS: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const OTHER: Address = "0x000000000000000000000000000000000000bEEF";
const NOW = 1_794_207_857;

function token(overrides: Partial<TokenFacts> = {}): TokenFacts {
  return {
    uid: "0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5",
    name: "NVIDIA • Robinhood Token",
    symbol: "NVDA",
    decimals: 18,
    totalSupply: 10n ** 21n,
    totalSupplyUI: 10n ** 21n,
    uiMultiplier: 10n ** 18n,
    newUIMultiplier: 10n ** 18n,
    effectiveAt: 0n,
    paused: false,
    tokenPaused: false,
    oraclePaused: false,
    registry: STOCK_REGISTRY,
    terms: "https://robinhood.com/stocktoken/rhj",
    interfaces: { scaledUIAmount: true, newUIMultiplier: true, balances: true },
    ...overrides,
  };
}

function reading(overrides: Partial<StockReading> = {}): StockReading {
  return {
    address: ADDRESS,
    blockNumber: 109_869_173n,
    blockTime: NOW,
    hasCode: true,
    beacon: STOCK_REGISTRY,
    token: token(),
    factoryRecord: ADDRESS,
    registryPaused: false,
    implementation: "0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2",
    ...overrides,
  };
}

describe("the verdict rests on the factory's record", () => {
  it("is registered when the factory records this address for its uid", () => {
    expect(verdictOf(reading()).kind).toBe("registered");
  });

  it("names the address the factory records instead", () => {
    expect(verdictOf(reading({ factoryRecord: OTHER }))).toMatchObject({ kind: "recorded-elsewhere", recorded: OTHER });
  });

  it("tells an unknown uid, a non-token contract and an empty address apart", () => {
    expect(verdictOf(reading({ factoryRecord: "0x0000000000000000000000000000000000000000" })).kind).toBe("unknown-uid");
    expect(verdictOf(reading({ token: null, factoryRecord: null })).kind).toBe("not-a-stock-token");
    expect(verdictOf(reading({ hasCode: false, token: null, factoryRecord: null })).kind).toBe("no-code");
  });
});

describe("the multiplier", () => {
  it("is 1.0 since deployment when it was never updated", () => {
    expect(multiplierFacts(token(), NOW)).toMatchObject({ value: "1", scheduled: null, inEffectSince: "deployment" });
  });

  it("dates the change in effect", () => {
    const facts = multiplierFacts(token({ uiMultiplier: 1000775159164630595n, newUIMultiplier: 1000775159164630595n, effectiveAt: 1_788_998_430n }), NOW);
    expect(facts).toMatchObject({ value: "1.000775159164630595", scheduled: null, inEffectSince: 1_788_998_430 });
  });

  it("shows a staged change, and takes the date of the value in effect from the history", () => {
    const staged = token({ uiMultiplier: 10n ** 18n, newUIMultiplier: 10n * 10n ** 18n, effectiveAt: BigInt(NOW + 3600) });
    expect(multiplierFacts(staged, NOW)).toMatchObject({ scheduled: { value: "10", effectiveAt: NOW + 3600 }, inEffectSince: "unknown" });
    const history = [
      { newMultiplier: "1000000000000000000", effectiveAt: NOW - 86_400 },
      { newMultiplier: "10000000000000000000", effectiveAt: NOW + 3600 },
    ];
    expect(multiplierFacts(staged, NOW, history).inEffectSince).toBe(NOW - 86_400);
    // A history without the staged update may be missing a later change: it is not trusted.
    expect(multiplierFacts(staged, NOW, history.slice(0, 1)).inEffectSince).toBe("unknown");
  });

  it("says how much an update scaled it", () => {
    expect(multiplierRatio(10n ** 18n, 4n * 10n ** 18n)).toBe("4");
    expect(multiplierRatio(10n ** 18n, 1000775159164630595n)).toBe("1.000775");
  });
});

describe("the price", () => {
  const listing: FeedListing = {
    ticker: "NVDA",
    name: "Robinhood NVDA / USD",
    assetName: null,
    proxy: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
    decimals: 8,
    heartbeatSeconds: 86_400,
    deviationPercent: 0.5,
    marketHours: "us_equities_24/5",
  };
  const feed = (overrides: Partial<FeedReading> = {}): FeedReading => ({
    proxy: listing.proxy,
    description: "RHNVDA / USD",
    decimals: 8,
    roundId: 1n,
    answer: 17_636_673_622n,
    updatedAt: NOW - 1429,
    blockNumber: 109_869_173n,
    ...overrides,
  });
  const nvda = token({ uiMultiplier: 1000775159164630595n, newUIMultiplier: 1000775159164630595n, effectiveAt: 1_788_998_430n });
  const multiplier = multiplierFacts(nvda, NOW);

  it("is one token's price, and divides back to one share by the multiplier", () => {
    const price = priceFacts(listing, feed(), nvda, multiplier, NOW);
    expect(price).toMatchObject({ answered: true, perToken: "176.36673622", ageSeconds: 1429, withinHeartbeat: true, oracleHeld: false });
    // 176.36673622 / 1.000775159164630595, to 8 decimals.
    expect(price.perShare).toEqual({ value: "176.23012982" });
  });

  it("does not divide when the two numbers may not belong together", () => {
    expect(priceFacts(listing, feed(), { ...nvda, oraclePaused: true }, multiplier, NOW).perShare).toEqual({ value: null, reason: "oracle-paused" });
    expect(priceFacts(listing, feed({ updatedAt: 1_788_998_000 }), nvda, multiplier, NOW).perShare).toEqual({
      value: null,
      reason: "multiplier-changed-since-update",
    });
    expect(priceFacts(listing, feed({ answer: 0n }), nvda, multiplier, NOW)).toMatchObject({ answered: false, perShare: { value: null, reason: "no-answer" } });
  });

  it("is outside the heartbeat after a day without an update", () => {
    expect(priceFacts(listing, feed({ updatedAt: NOW - 90_000 }), nvda, multiplier, NOW).withinHeartbeat).toBe(false);
  });
});

describe("whether it can move", () => {
  it("reads paused() and the oracle flag", () => {
    expect(movementFacts(reading(), token())).toEqual({ transfers: "open", tokenPaused: false, registryPaused: false, oracle: "publishing" });
    expect(movementFacts(reading({ registryPaused: true }), token({ paused: true, oraclePaused: true }))).toMatchObject({
      transfers: "paused",
      registryPaused: true,
      oracle: "held",
    });
  });
});
