/** Words and times for the facts, the same on the web and in a terminal. Times are in UTC. */

const UTC = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

const UTC_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "9 Nov 2026, 07:04 UTC". */
export function formatUtc(unixSeconds: number): string {
  return `${UTC.format(new Date(unixSeconds * 1000))} UTC`;
}

/** "9 Nov 2026". */
export function formatUtcDay(unixSeconds: number): string {
  return UTC_DAY.format(new Date(unixSeconds * 1000));
}

/** "24 min ago", "in 3 days": the distance from `now` to `at`, both in Unix seconds. */
export function relativeTime(at: number, now: number): string {
  const delta = at - now;
  const size = Math.abs(delta);
  let text: string;
  if (size < 45) return "just now";
  if (size < 90 * 60) text = `${Math.max(1, Math.round(size / 60))} min`;
  else if (size < 48 * 3600) text = `${Math.round(size / 3600)} h`;
  else text = `${Math.round(size / 86_400)} days`;
  return delta < 0 ? `${text} ago` : `in ${text}`;
}

/** A heartbeat or an age as a short span: 86400 is "24 h". */
export function formatSpan(seconds: number): string {
  if (seconds % 86_400 === 0 && seconds >= 2 * 86_400) return `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Every token's on-chain name ends in "• Robinhood Token"; a list can leave that out. */
export function shortName(name: string): string {
  return name.replace(/\s*•\s*Robinhood Token$/, "");
}
