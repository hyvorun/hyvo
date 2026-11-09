// Amounts stay bigint end to end; these are the only places they become text, and they never touch a float.

const WEI_PER_ETH = 10n ** 18n;

/** Exact decimal form of `value` with `decimals` places, trailing zeros removed: formatUnits(1500000n, 6) -> "1.5". */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = decimals > 0 ? frac.toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return (negative ? "-" : "") + whole.toString() + (fracStr ? `.${fracStr}` : "");
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Readable form for evidence: thousands separated, and cut (never rounded up) to 2 decimals from 1,000, to 4
 * from 1, and to 6 significant digits below 1. formatAmount(581054078393318008147934n, 18) -> "581,054.07".
 */
export function formatAmount(value: bigint, decimals: number): string {
  const exact = formatUnits(value < 0n ? -value : value, decimals);
  const sign = value < 0n ? "-" : "";
  const [whole = "0", frac = ""] = exact.split(".");
  let shown: string;
  if (whole !== "0") {
    const keep = whole.length >= 4 ? 2 : 4;
    shown = frac.slice(0, keep).replace(/0+$/, "");
  } else {
    const lead = frac.length - frac.replace(/^0+/, "").length;
    shown = frac.slice(0, lead + 6).replace(/0+$/, "");
  }
  return sign + group(whole) + (shown ? `.${shown}` : "");
}

export function formatEth(wei: bigint): string {
  return `${formatAmount(wei, 18)} ETH`;
}

/** Parses a decimal ETH string such as "0.02", "0.02eth" or "1 ether" into wei. */
export function parseEth(input: string): bigint {
  const cleaned = input.trim().replace(/(ether|eth)$/i, "").trim();
  if (!/^\d*(\.\d+)?$/.test(cleaned) || cleaned === "" || cleaned === ".") {
    throw new Error(`invalid ETH amount: ${input}`);
  }
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > 18) throw new Error(`more than 18 decimals: ${input}`);
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * WEI_PER_ETH + BigInt(fracPadded || "0");
}

/** A percentage with up to 2 decimals, e.g. 3.9512 -> "3.95%". */
export function formatPct(pct: number): string {
  const rounded = Math.round(pct * 100) / 100;
  return `${rounded.toFixed(2).replace(/\.?0+$/, "") || "0"}%`;
}

/** (promised - arrived) / promised in percent, to 4 decimals, computed in bigint. */
export function shortfallPct(promised: bigint, arrived: bigint): number {
  if (promised <= 0n) return 0;
  return Number(((promised - arrived) * 1_000_000n) / promised) / 10_000;
}
