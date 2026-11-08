/** Number and text formatting for the interface. Prices and amounts come in as run.json decimal
 * strings or floats derived from them; nothing here feeds back into data. */

export interface PriceUnit {
  factor: number;
  /** e.g. "ETH per 1M GLINT" */
  label: string;
}

const UNITS = [
  [1, ""],
  [1e3, "1K"],
  [1e6, "1M"],
  [1e9, "1B"],
] as const;

/**
 * The unit prices are quoted in: the smallest of per token, per 1K, per 1M or per 1B tokens that
 * shows the largest price as at least 0.01 (the report uses the same rule). A token worth
 * 0.00000005 ETH reads "0.05 ETH per 1M GLINT".
 */
export function priceUnit(prices: number[], symbol: string): PriceUnit {
  const top = Math.max(...prices.filter(Number.isFinite));
  for (const [factor, label] of UNITS) {
    if (top * factor >= 0.01) return { factor, label: label ? `ETH per ${label} ${symbol}` : `ETH per ${symbol}` };
  }
  return { factor: 1e9, label: `ETH per 1B ${symbol}` };
}

/** A price in `unit`, four significant digits. */
export function formatScaled(price: number, unit: PriceUnit): string {
  const value = price * unit.factor;
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) return Math.round(value).toLocaleString("en-US");
  return trimZeros(value.toPrecision(4));
}

/** Plain-text version of a price for screen readers and titles. */
export function spokenPrice(price: number): string {
  return Number.isFinite(price) ? price.toExponential(3) : "unknown";
}

export function formatEth(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === 0) return "0";
  if (Math.abs(n) < 0.0001) return n.toExponential(1);
  return trimZeros(n.toFixed(Math.abs(n) >= 100 ? 2 : 4));
}

export function formatTokens(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (Math.abs(n) >= 1e9) return `${trimZeros((n / 1e9).toFixed(2))}B`;
  if (Math.abs(n) >= 1e6) return `${trimZeros((n / 1e6).toFixed(2))}M`;
  if (Math.abs(n) >= 1e4) return `${trimZeros((n / 1e3).toFixed(1))}K`;
  return trimZeros(n.toFixed(n >= 100 ? 0 : 2));
}

export function formatPct(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 1)}%`;
}

export function shortHash(hash: string, head = 6, tail = 4): string {
  return hash.length <= head + tail + 2 ? hash : `${hash.slice(0, head + 2)}…${hash.slice(-tail)}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function personaLabel(persona: string, count = 1): string {
  const names: Record<string, [string, string]> = {
    sniper: ["Sniper", "Snipers"],
    holder: ["Holder", "Holders"],
    panic_seller: ["Panic seller", "Panic sellers"],
    skeptic: ["Skeptic", "Skeptics"],
    swing_trader: ["Swing trader", "Swing traders"],
    whale: ["Whale", "Whales"],
    kol_follower: ["KOL follower", "KOL followers"],
    market_maker_bot: ["Market maker bot", "Market maker bots"],
    stock_token_holder: ["Stock token holder", "Stock token holders"],
    newcomer: ["Newcomer", "Newcomers"],
    clone: ["Clone", "Clones"],
  };
  const [one, many] = names[persona] ?? [persona, persona];
  return count === 1 ? one : many;
}

/** The text of a post the last read of a run removed (docs/RUN_FORMAT.md). */
export const REMOVED_POST = "[Removed by the copy guard.]";

export function modelLabel(model: string): string {
  if (model === "offline/rules-v1") return "offline rules model";
  return model.replace(/^@cf\/[^/]+\//, ""); // a Workers AI id: the model's own name is enough
}

function trimZeros(text: string): string {
  return text.includes(".") && !text.includes("e") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}
