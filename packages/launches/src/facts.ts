/**
 * Facts derived from what was read, and the words and numbers they are shown with. Nothing here
 * rates a token: progress is arithmetic on two numbers the curve holds, and every amount is in the
 * launch's own pair asset.
 */
import { formatUnits } from "viem";
import type { Phase } from "./pons";

/**
 * How far a curve is towards graduation, from 0 to 1: the pair asset it holds over the amount at
 * which it graduates (PonsV2BondingCurve: the curve reaches `graduationThreshold` of real quote
 * exactly when its sellable tokens run out).
 */
export function progress(liquidity: bigint | null, threshold: bigint): number | null {
  if (liquidity === null || threshold <= 0n) return null;
  if (liquidity >= threshold) return 1;
  // Four decimal places of a ratio are plenty for a bar and a percentage.
  return Number((liquidity * 10_000n) / threshold) / 10_000;
}

/** "1%", "0.5%", "0%" from basis points. */
export function formatBps(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  if (percent >= 99.95 && percent < 100) return ">99.9%";
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1).replace(/\.0$/, "")}%`;
}

/**
 * An amount in its own units with four significant digits, and thousands separated: "0.04661",
 * "916.9", "8,090", "1.25M". Zero is "0".
 */
export function formatAmount(value: bigint, decimals: number): string {
  if (value === 0n) return "0";
  const negative = value < 0n;
  const text = formatUnits(negative ? -value : value, decimals);
  const n = Number(text);
  let out: string;
  if (n >= 1e9) out = `${trim((n / 1e9).toPrecision(3))}B`;
  else if (n >= 1e6) out = `${trim((n / 1e6).toPrecision(3))}M`;
  else if (n >= 1e4) out = Math.round(n).toLocaleString("en-US");
  else if (n >= 1) out = trim(n.toPrecision(4)).replace(/^(\d+)(\.|$)/, (_, whole: string, dot: string) => `${Number(whole).toLocaleString("en-US")}${dot}`);
  else if (n >= 0.000001) out = trim(n.toPrecision(4));
  else out = "<0.000001";
  return negative ? `−${out}` : out;
}

/** A token count such as "1B", "285.7M" or "12,400". */
export function formatTokens(value: bigint, decimals = 18): string {
  return formatAmount(value, decimals);
}

function trim(text: string): string {
  return text.includes(".") && !text.includes("e") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** "12 s", "5 min", "3 h 20 min", "2 d 4 h". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** "9 Nov 2026, 06:39 UTC", the same in every locale. */
export function formatUtc(seconds: number): string {
  const date = new Date(seconds * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** "06:39:07 UTC". */
export function formatClock(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(11, 19)} UTC`;
}

export function formatBlock(block: bigint): string {
  return block.toLocaleString("en-US");
}

/** Where a launch trades, in plain words. */
export function phaseLabel(phase: Phase | null, graduated: boolean | null): string {
  if (phase === "graduated") return "Graduated";
  if (phase === "swept") return "Leaving its curve";
  if (phase === "rescued") return "Reserves released";
  if (phase === "curve") return "On its curve";
  if (graduated === true) return "Graduated";
  if (graduated === false) return "On its curve";
  return "Unknown";
}

export function phaseExplained(phase: Phase | null): string {
  switch (phase) {
    case "curve":
      return "Trades on its Pons bonding curve. It graduates when the curve holds its threshold of the pair asset.";
    case "swept":
      return "Its curve has been emptied into the factory and trading on it has stopped. The Uniswap V4 pool is not created yet.";
    case "graduated":
      return "Trades in a Uniswap V4 pool with the Pons hook. Its liquidity position is locked, and its curve no longer trades.";
    case "rescued":
      return "Its curve was emptied, and the reserves were released by hand because the pair asset stopped transferring exact amounts.";
    default:
      return "The factory's record did not say.";
  }
}

/** The short form of an address: 0x1234…abcd. */
export function shortAddress(address: string, head = 4, tail = 4): string {
  return address.length <= head + tail + 2 ? address : `${address.slice(0, head + 2)}…${address.slice(-tail)}`;
}
