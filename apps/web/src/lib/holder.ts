import { z } from "zod";
import { API_URL } from "./api";

/*
 * What holding HYVO brings, shown on the token page and the home page. These mirror
 * apps/api/wrangler.jsonc (FREE_RUNS_PER_MONTH, FREE_RUN_MAX_AGENTS, FREE_RUN_MAX_ROUNDS,
 * HOLDER_DISCOUNT_BPS) and apps/api/src/lib/holder.ts; change them together. Before the launch the
 * pages call them draft numbers.
 */
export const HOLDER_BENEFITS = { freeRuns: 2, freeAgents: 50, freeRounds: 10, discountPct: 20 } as const;

/**
 * What holding HYVO unlocks beyond runs, under the same rule: the board refreshing every 10 seconds (lib/holder-status.ts),
 * the watchlist kept with the account and up to 25 followed wallets on /track (packages/schema TRACKED_MAX_HOLDER).
 * Utilities only: nothing about the token's price, value or returns.
 */
export const HOLDER_UTILITIES = [
  { name: "Board live", line: "The board of new launches refreshes every 10 seconds, instead of every minute.", to: "/board" },
  { name: "Watchlist sync", line: "Your watchlist of launches is kept with your account and reaches every browser you sign in on.", to: "/watchlist" },
  // No "Pons", "buy", "sell", "fee" or "tax" here: the token page names none of them (e2e/token-live.spec.ts).
  { name: "25 tracked wallets", line: "Follow up to 25 wallets on Track and see their trades on new launches, instead of 1.", to: "/track" },
] as const;

/**
 * Who will count as a holder, the founder's decision of 2026-11-09: at least 1,000,000 HYVO in one wallet,
 * now and 24 hours earlier. `token:go-live` sets HOLDER_MIN to it at the launch; from then on the pages read
 * the rule from GET /v1/health instead.
 */
export const HOLDER_RULE = { min: "1000000", heldForSeconds: 86_400 } as const;

/** HOLDER_RULE in one sentence, before the launch. */
export const PLANNED_RULE = "For a wallet that holds at least 1,000,000 HYVO, now and 24 hours earlier.";

/** The earlier name of HOLDER_BENEFITS, kept so code written against it still builds. */
export const HOLDER_DRAFT = HOLDER_BENEFITS;

/**
 * Who counts as a holder, as GET /v1/health states it once holder benefits are on: at least `min`
 * whole HYVO (a decimal string, HOLDER_MIN) in one wallet, both now and `heldForSeconds` earlier.
 * Read with a schema of its own rather than the shared HealthResponse, so this works the same with
 * an API that does not send the field yet.
 */
const HolderTermsSchema = z.object({
  min: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
  decimals: z.int().min(0).max(255),
  heldForSeconds: z.int().positive(),
});

export type HolderTerms = z.infer<typeof HolderTermsSchema>;

const HealthHolder = z.object({ holder: HolderTermsSchema.nullish() });

/** The holder terms in an answer of GET /v1/health; null when they are off, missing or unreadable. */
export function holderTermsFrom(health: unknown): HolderTerms | null {
  const parsed = HealthHolder.safeParse(health);
  if (!parsed.success || !parsed.data.holder) return null;
  // A minimum of zero turns the benefits off (apps/api/src/lib/holder.ts), so it states no rule.
  return /[1-9]/.test(parsed.data.holder.min) ? parsed.data.holder : null;
}

/** GET /v1/health's holder terms, or null when the API does not state them or cannot be reached. Never throws. */
export async function fetchHolderTerms(): Promise<HolderTerms | null> {
  try {
    const response = await fetch(`${API_URL}/v1/health`, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return holderTermsFrom(await response.json());
  } catch {
    return null;
  }
}

/** A whole-HYVO decimal string for reading: "1000000" -> "1,000,000", "2500.50" -> "2,500.5". */
export function formatHyvo(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  const grouped = (whole.replace(/^0+(?=\d)/, "") || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const kept = fraction.replace(/0+$/, "");
  return kept ? `${grouped}.${kept}` : grouped;
}

/** A holding period in words: 86400 -> "24 hours", 604800 -> "7 days", 1800 -> "30 minutes". */
export function durationText(seconds: number): string {
  const count = (n: number, unit: string) => `${n.toLocaleString("en-US")} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds > 86_400 && seconds % 86_400 === 0) return count(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return count(seconds / 3_600, "hour");
  if (seconds % 60 === 0) return count(seconds / 60, "minute");
  return count(seconds, "second");
}

/** The words for the holder rule when the API does not state it. */
export const HOLDER_RULE_UNSET = "How much to hold, and for how long, is set at the launch.";

/** Who counts as a holder, in one sentence. */
export function holderRule(terms: HolderTerms | null): string {
  if (!terms) return HOLDER_RULE_UNSET;
  return `Hold at least ${formatHyvo(terms.min)} HYVO in one wallet, now and ${durationText(terms.heldForSeconds)} earlier.`;
}
