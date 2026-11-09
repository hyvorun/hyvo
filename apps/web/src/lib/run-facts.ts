/**
 * The facts the home page tells about one run, read straight from its file: what the crowd did,
 * who was in it, and what the copy guard took out. Nothing here is estimated.
 */
import { RUN_PERSONAS, type RunV1 } from "@hyvo/schema";
import { personaLabel } from "./format";

export interface RunFacts {
  /** One per agent per round: every action the run recorded, holds included. */
  decisions: number;
  buys: number;
  sells: number;
  /** Swaps that were sent and reverted, such as on slippage. */
  reverted: number;
  /** Posts and replies in the feed, including any the copy guard later took out. */
  posts: number;
  /** Posts the last read of the run took out (`posts_removed:N` on the report). */
  removedPosts: number;
}

export function runFacts(run: RunV1): RunFacts {
  const actions = run.rounds.flatMap((round) => round.actions);
  const swaps = (kind: "swap_buy" | "swap_sell") => actions.filter((action) => action.kind === kind && action.status === "ok").length;
  return {
    decisions: actions.length,
    buys: swaps("swap_buy"),
    sells: swaps("swap_sell"),
    reverted: actions.filter((action) => action.status === "reverted").length,
    posts: run.rounds.reduce((sum, round) => sum + round.posts.length, 0),
    removedPosts: postsRemoved(run.report.flags),
  };
}

/** How many posts the copy guard took out, from the report's flags; 0 when it took none. */
export function postsRemoved(flags: readonly string[]): number {
  let removed = 0;
  for (const flag of flags) {
    const [name, detail] = flag.split(":");
    const count = Number(detail);
    if (name === "posts_removed" && Number.isInteger(count) && count > 0) removed += count;
  }
  return removed;
}

/** "10 snipers, 15 holders, 10 panic sellers and 15 skeptics", in the order the crowd lists them. */
export function crowdMix(run: RunV1): string {
  const known = RUN_PERSONAS as readonly string[];
  const counts = new Map<string, number>();
  for (const agent of run.crowd.agents) counts.set(agent.persona, (counts.get(agent.persona) ?? 0) + 1);
  const rank = (persona: string) => (known.includes(persona) ? known.indexOf(persona) : known.length);
  const parts = [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([persona, count]) => {
      const label = personaLabel(persona, count);
      // "KOL followers" keeps its capitals; "Snipers" reads as "snipers" mid-sentence.
      const name = /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
      return `${count.toLocaleString("en-US")} ${name}`;
    });
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

/** How many agents of each archetype a run seated, for marking them in a list. */
export function personaCounts(run: RunV1): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of run.crowd.agents) counts.set(agent.persona, (counts.get(agent.persona) ?? 0) + 1);
  return counts;
}

/** A report line without its post citations: "concerns about the tax structure (p13, c15)" -> "concerns about the tax structure". */
export function withoutCitations(text: string): string {
  return text
    .replace(/\s*\([a-z]\d+(?:,\s?[a-z]\d+)*\)/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** How many blocks the real chain moved on between the fork and the commit; null when either is unknown. */
export function blocksBetween(forkBlock: number | null, commitBlock: number | null): number | null {
  if (forkBlock === null || commitBlock === null || commitBlock < forkBlock) return null;
  return commitBlock - forkBlock;
}
