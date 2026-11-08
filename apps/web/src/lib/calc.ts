/**
 * The arithmetic behind the free tools: a constant-product swap, impermanent loss and unit
 * conversions. Pure functions, so they are tested without a page (test/calc.test.ts). Nothing here
 * reads a chain or a price feed: every number comes from what the person types.
 */

/** A pool of ETH and one token, in whole units. */
export interface PoolState {
  eth: number;
  tokens: number;
}

/** What goes into the pool: ETH (to receive tokens) or tokens (to receive ETH). */
export type Side = "eth-in" | "tokens-in";

export interface Quote {
  side: Side;
  amountIn: number;
  amountOut: number;
  /** The fee, in the unit that goes in. */
  fee: number;
  /** The pool's price, ETH per token, before and after the trade. */
  priceBefore: number;
  priceAfter: number;
  /** ETH per token over the whole trade, fee included. */
  averagePrice: number;
  /** How far the pool's price moves, as a fraction: 0.05 is 5% up, -0.05 is 5% down. */
  priceMove: number;
  /** How much worse than the price before the trade the whole trade fills, fee included: 0.03 is 3% worse. */
  costVsSpot: number;
  after: PoolState;
}

/**
 * One swap against a constant-product pool (x · y = k), Uniswap V2 style: the fee is taken from
 * what goes in and stays in the pool. The same rule as `amountOut` in lib/replay.ts, which the
 * fork's test pools use, in floating point instead of integers. Null when an input is out of range.
 */
export function quote(pool: PoolState, feePct: number, side: Side, amountIn: number): Quote | null {
  if (!(pool.eth > 0) || !(pool.tokens > 0) || !(amountIn > 0) || !(feePct >= 0) || !(feePct < 100)) return null;
  if (!Number.isFinite(pool.eth) || !Number.isFinite(pool.tokens) || !Number.isFinite(amountIn)) return null;
  const [reserveIn, reserveOut] = side === "eth-in" ? [pool.eth, pool.tokens] : [pool.tokens, pool.eth];
  const inAfterFee = amountIn * (1 - feePct / 100);
  const amountOut = (inAfterFee * reserveOut) / (reserveIn + inAfterFee);
  const after =
    side === "eth-in" ? { eth: pool.eth + amountIn, tokens: pool.tokens - amountOut } : { eth: pool.eth - amountOut, tokens: pool.tokens + amountIn };
  const priceBefore = pool.eth / pool.tokens;
  const priceAfter = after.eth / after.tokens;
  const averagePrice = side === "eth-in" ? amountIn / amountOut : amountOut / amountIn;
  return {
    side,
    amountIn,
    amountOut,
    fee: amountIn * (feePct / 100),
    priceBefore,
    priceAfter,
    averagePrice,
    priceMove: priceAfter / priceBefore - 1,
    // Paying more ETH per token is worse when ETH goes in; getting less ETH per token is worse when tokens go in.
    costVsSpot: side === "eth-in" ? averagePrice / priceBefore - 1 : 1 - averagePrice / priceBefore,
    after,
  };
}

/** Put ETH in, then at once put every token received back: what comes back, and the share of the ETH lost. */
export function roundTrip(pool: PoolState, feePct: number, ethIn: number): { ethBack: number; loss: number } | null {
  const first = quote(pool, feePct, "eth-in", ethIn);
  if (!first) return null;
  const second = quote(first.after, feePct, "tokens-in", first.amountOut);
  if (!second) return null;
  return { ethBack: second.amountOut, loss: 1 - second.amountOut / ethIn };
}

/** Trade sizes for the table, as shares of the ETH in the pool. */
export const TRADE_SHARES = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25] as const;

/**
 * Impermanent loss of a 50/50 constant-product position when the token's price against the other
 * asset is multiplied by `ratio` (2 = doubled, 0.5 = halved): the position's value against simply
 * holding both, as a fraction (-0.0572 for a doubling). Fees earned are not counted.
 */
export function impermanentLoss(ratio: number): number | null {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  return (2 * Math.sqrt(ratio)) / (1 + ratio) - 1;
}

/**
 * The same position in amounts: `deposit` split half and half at the start, valued in the other
 * asset after the price moves by `ratio`.
 */
export function positionValues(deposit: number, ratio: number): { held: number; pooled: number } | null {
  if (!(deposit > 0) || !Number.isFinite(deposit) || !(ratio > 0) || !Number.isFinite(ratio)) return null;
  return { held: (deposit / 2) * (1 + ratio), pooled: deposit * Math.sqrt(ratio) };
}

/** Price moves for the impermanent loss table, as changes in percent. */
export const PRICE_MOVES = [-90, -75, -50, -25, 25, 50, 100, 200, 400, 900] as const;

/**
 * A number as a person types it: "1,000,000", "0.5", "1e9", "2.5m" or "1B" (k, m, b and t are
 * thousand, million, billion and trillion). A leading + or - is kept when `signed`. NaN when the
 * text is not a number.
 */
export function parseAmount(text: string, signed = false): number {
  let cleaned = text
    .trim()
    .replace(/[,_\s]/g, "")
    .replace(/−/g, "-")
    .toLowerCase();
  let sign = 1;
  if (signed && /^[+-]/.test(cleaned)) {
    sign = cleaned.startsWith("-") ? -1 : 1;
    cleaned = cleaned.slice(1);
  }
  const match = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e([+-]?[0-9]{1,3}))?([kmbt])?$/.exec(cleaned);
  if (!match) return Number.NaN;
  const base = Number(`${match[1]}${match[2] ? `e${match[2]}` : ""}`);
  const scale = match[3] ? { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[3] as "k" | "m" | "b" | "t"] : 1;
  return sign * base * scale;
}

/** A plain decimal ("1.5", "0.000001") in base units with `decimals` places, exactly. Null when it is not one or has too many places. */
export function toBaseUnits(text: string, decimals: number): bigint | null {
  const match = /^([0-9]*)(?:\.([0-9]*))?$/.exec(text.trim().replace(/[,_\s]/g, ""));
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return null;
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Base units back to a plain decimal with no trailing zeros: 1500000000000000000n, 18 -> "1.5". */
export function fromBaseUnits(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const fraction = decimals > 0 ? (magnitude % unit).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${sign}${magnitude / unit}${fraction ? `.${fraction}` : ""}`;
}

/** Groups the whole part of a plain decimal: "1234567.5" -> "1,234,567.5". */
export function groupDigits(decimal: string): string {
  const [whole = "", fraction] = decimal.split(".");
  const grouped = whole.replace(/\B(?=([0-9]{3})+(?![0-9]))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** A computed amount for reading: six significant digits, grouped, and exponent form when tiny or huge. */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "–";
  if (value === 0) return "0";
  const size = Math.abs(value);
  const text = size < 1e-9 || size >= 1e15 ? value.toExponential(3).replace("e+", "e") : value.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  return text.replace(/^-/, "−");
}

/** A fraction as a percentage for reading: 0.0572 -> "5.72%"; with `signed`, "+5.72%" or "−5.72%". */
export function formatShare(fraction: number, signed = false): string {
  if (!Number.isFinite(fraction)) return "–";
  const pct = fraction * 100;
  const size = Math.abs(pct);
  const digits = size === 0 ? 0 : size < 0.01 ? 4 : size < 10 ? 2 : size < 100 ? 1 : 0;
  const text = `${size.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
  if (!signed || pct === 0) return pct < 0 ? `−${text}` : text;
  return `${pct > 0 ? "+" : "−"}${text}`;
}
