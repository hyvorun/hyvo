/**
 * Exact decimal arithmetic on raw fixed-point integers. Multipliers and prices stay bigint from the
 * chain to the screen, so nothing is rounded except where a function says so.
 */
import { formatUnits } from "viem";

/** Every digit of a raw fixed-point value: 1000775159164630595n at 18 decimals is "1.000775159164630595". */
export function formatFixed(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

/** num / den to `places` decimals, rounded half to even. Both must be positive or zero. */
export function divideToDecimal(num: bigint, den: bigint, places: number): string {
  if (den <= 0n || num < 0n) throw new RangeError("divideToDecimal takes num >= 0 and den > 0");
  const scale = 10n ** BigInt(places);
  const scaled = num * scale;
  let quotient = scaled / den;
  const remainder = scaled % den;
  const twice = remainder * 2n;
  if (twice > den || (twice === den && quotient % 2n === 1n)) quotient += 1n;
  return formatUnits(quotient, places);
}

/** A decimal string rounded to `places`, half to even: ("176.36673622", 2) is "176.37". */
export function roundDecimal(text: string, places: number): string {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) throw new RangeError(`not a plain decimal: ${text}`);
  const fraction = match[2] ?? "";
  const digits = BigInt(match[1]! + fraction.padEnd(places, "0").slice(0, places) || "0");
  const rest = fraction.slice(places);
  let rounded = digits;
  if (rest.length > 0) {
    const first = Number(rest[0]);
    const tail = /[1-9]/.test(rest.slice(1));
    if (first > 5 || (first === 5 && (tail || digits % 2n === 1n))) rounded += 1n;
  }
  const out = formatUnits(rounded, places);
  if (places === 0) return out;
  const [whole, frac = ""] = out.split(".");
  return `${whole}.${frac.padEnd(places, "0")}`;
}

/** Thousands separators in the whole part: "1415.17" is "1,415.17". */
export function groupThousands(text: string): string {
  const [whole, fraction] = text.split(".");
  const grouped = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
