/**
 * Answers drawn from a reading, with nothing added. Each function says which on-chain value it
 * rests on; the meaning of the multiplier and the price follows ERC-8056 and Chainlink's page on
 * Robinhood tokenized equities (contracts.ts, SOURCES).
 */
import { zeroAddress, type Address, type Hex } from "viem";
import { MULTIPLIER_DECIMALS, STOCK_REGISTRY } from "./contracts";
import { divideToDecimal, formatFixed } from "./decimal";
import type { FeedListing } from "./feeds";
import type { FeedReading, StockReading, TokenFacts } from "./read";

export type Verdict =
  /** The factory records this address for the contract's uid. */
  | { kind: "registered"; uid: Hex }
  /** The contract answers like a stock token, but the factory records another address for its uid. */
  | { kind: "recorded-elsewhere"; uid: Hex; recorded: Address }
  /** The contract answers like a stock token, but the factory has no token for its uid. */
  | { kind: "unknown-uid"; uid: Hex }
  | { kind: "no-code" }
  /** A contract that does not answer the stock token functions. */
  | { kind: "not-a-stock-token" };

export function verdictOf(reading: StockReading): Verdict {
  if (!reading.hasCode) return { kind: "no-code" };
  if (!reading.token) return { kind: "not-a-stock-token" };
  const { uid } = reading.token;
  const recorded = reading.factoryRecord;
  if (!recorded || recorded.toLowerCase() === zeroAddress) return { kind: "unknown-uid", uid };
  if (recorded.toLowerCase() === reading.address.toLowerCase()) return { kind: "registered", uid };
  return { kind: "recorded-elsewhere", uid, recorded };
}

/** Facts that back the verdict up: the proxy's beacon and the registry the token names. */
export function systemFacts(reading: StockReading) {
  const isRegistry = (address: Address | null | undefined) => (address ? address.toLowerCase() === STOCK_REGISTRY.toLowerCase() : null);
  return {
    beaconIsRegistry: isRegistry(reading.beacon),
    namesRegistry: isRegistry(reading.token?.registry),
  };
}

export interface MultiplierFacts {
  raw: bigint;
  /** Every digit: "1.000775159164630595". */
  value: string;
  /** A change staged with updateMultiplier(value, effectiveAt) that has not taken effect yet. */
  scheduled: { raw: bigint; value: string; effectiveAt: number } | null;
  /**
   * When the multiplier in effect took effect: a Unix time, "deployment" if it was never changed,
   * or "unknown" when a change is staged and the history at hand does not reach back to the last one.
   */
  inEffectSince: number | "deployment" | "unknown";
}

/**
 * The multiplier at the reading's block. Per src/Stock.sol, uiMultiplier() switches to
 * newUIMultiplier() once the block time reaches effectiveAt(), so a change is still scheduled only
 * while effectiveAt() is later than the block and the two values differ. effectiveAt() then holds
 * the staged time, and `history` (Hyvo's scan) tells when the value in effect took effect.
 */
export function multiplierFacts(
  token: TokenFacts,
  blockTime: number,
  history?: readonly { newMultiplier: string; effectiveAt: number }[],
): MultiplierFacts {
  const effectiveAt = Number(token.effectiveAt);
  const staged = effectiveAt > blockTime;
  const pending = staged && token.newUIMultiplier !== token.uiMultiplier;
  let inEffectSince: MultiplierFacts["inEffectSince"];
  if (effectiveAt === 0) inEffectSince = "deployment";
  else if (!staged) inEffectSince = effectiveAt;
  else {
    // The history must hold the staged update itself, or a later change could be missing from it.
    const holdsStaged = history?.some((update) => update.effectiveAt === effectiveAt && BigInt(update.newMultiplier) === token.newUIMultiplier) ?? false;
    const earlier = history?.filter((update) => update.effectiveAt <= blockTime) ?? [];
    inEffectSince = !holdsStaged ? "unknown" : earlier.length > 0 ? earlier[earlier.length - 1]!.effectiveAt : "deployment";
  }
  return {
    raw: token.uiMultiplier,
    value: formatFixed(token.uiMultiplier, MULTIPLIER_DECIMALS),
    scheduled: pending ? { raw: token.newUIMultiplier, value: formatFixed(token.newUIMultiplier, MULTIPLIER_DECIMALS), effectiveAt } : null,
    inEffectSince,
  };
}

/** new / old to `places` decimals: how much one update scaled the multiplier. */
export function multiplierRatio(oldRaw: bigint, newRaw: bigint, places = 6): string {
  return divideToDecimal(newRaw, oldRaw, places);
}

export interface PriceFacts {
  /** The feed's answer: the price of one token in USD, every digit. */
  perToken: string;
  decimals: number;
  updatedAt: number;
  ageSeconds: number;
  /** Whether the last update is younger than the feed's heartbeat (Chainlink's directory). */
  withinHeartbeat: boolean;
  /** The token's oraclePaused(): while true, Chainlink says the feed holds its last value. */
  oracleHeld: boolean | null;
  /**
   * The answer divided by the multiplier: Chainlink's formula (token price = underlying price ×
   * uiMultiplier) read backwards. Shown only when the multiplier in effect was already in effect at
   * the feed's last update and the oracle is not paused.
   */
  perShare:
    | { value: string }
    | { value: null; reason: "oracle-paused" | "multiplier-changed-since-update" | "multiplier-timing-unknown" | "no-answer" };
  /** False for an answer of zero or below, which Chainlink says to treat as invalid. */
  answered: boolean;
}

export function priceFacts(listing: FeedListing, feed: FeedReading, token: TokenFacts, multiplier: MultiplierFacts, now: number): PriceFacts {
  const ageSeconds = Math.max(0, now - feed.updatedAt);
  const answered = feed.answer > 0n;
  const since = multiplier.inEffectSince;
  let perShare: PriceFacts["perShare"];
  if (!answered) perShare = { value: null, reason: "no-answer" };
  else if (token.oraclePaused) perShare = { value: null, reason: "oracle-paused" };
  else if (since === "unknown") perShare = { value: null, reason: "multiplier-timing-unknown" };
  else if (typeof since === "number" && since > feed.updatedAt) perShare = { value: null, reason: "multiplier-changed-since-update" };
  // (answer / 10^feedDecimals) / (multiplier / 10^18), kept to the feed's decimals.
  else perShare = { value: divideToDecimal(feed.answer * 10n ** BigInt(MULTIPLIER_DECIMALS), multiplier.raw * 10n ** BigInt(feed.decimals), feed.decimals) };
  return {
    answered,
    perToken: formatFixed(feed.answer, feed.decimals),
    decimals: feed.decimals,
    updatedAt: feed.updatedAt,
    ageSeconds,
    withinHeartbeat: ageSeconds <= listing.heartbeatSeconds,
    oracleHeld: token.oraclePaused,
    perShare,
  };
}

export interface MovementFacts {
  /** paused(): the token's own switch or the registry's. */
  transfers: "open" | "paused";
  tokenPaused: boolean | null;
  registryPaused: boolean | null;
  oracle: "publishing" | "held" | "unknown";
}

export function movementFacts(reading: StockReading, token: TokenFacts): MovementFacts {
  return {
    transfers: token.paused ? "paused" : "open",
    tokenPaused: token.tokenPaused,
    registryPaused: reading.registryPaused,
    oracle: token.oraclePaused === null ? "unknown" : token.oraclePaused ? "held" : "publishing",
  };
}
