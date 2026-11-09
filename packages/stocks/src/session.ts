/**
 * The US equity session at a given moment, by the clock in New York, using the session table on
 * Chainlink's Tokenized Equity Feeds page (docs.chain.link/data-feeds/tokenized-equity-feeds):
 * pre-market 04:00 to 09:30, regular 09:30 to 16:00, post-market 16:00 to 20:00, overnight 20:00
 * to 04:00, and the weekend from Friday 20:00 to Sunday 20:00. Market holidays are not in that
 * table and not known here.
 */
export type UsEquitySession = "pre-market" | "regular" | "post-market" | "overnight" | "weekend";

export const SESSION_LABELS: Record<UsEquitySession, string> = {
  "pre-market": "Pre-market (04:00 to 09:30 ET)",
  regular: "Regular trading (09:30 to 16:00 ET)",
  "post-market": "Post-market (16:00 to 20:00 ET)",
  overnight: "Overnight (20:00 to 04:00 ET)",
  weekend: "Weekend: traditional markets closed (Friday 20:00 to Sunday 20:00 ET)",
};

export interface SessionNow {
  session: UsEquitySession;
  /** "Mon", "Tue", … in New York. */
  weekday: string;
  /** "14:05" in New York. */
  time: string;
}

export function usEquitySession(at: Date): SessionNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const minutes = hour * 60 + minute;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  const weekend = weekday === "Sat" || (weekday === "Sun" && minutes < 20 * 60) || (weekday === "Fri" && minutes >= 20 * 60);
  let session: UsEquitySession;
  if (weekend) session = "weekend";
  else if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) session = "pre-market";
  else if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) session = "regular";
  else if (minutes >= 16 * 60 && minutes < 20 * 60) session = "post-market";
  else session = "overnight";
  return { session, weekday, time };
}
