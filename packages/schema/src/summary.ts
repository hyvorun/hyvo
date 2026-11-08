import type { RunSummary } from "./api";
import type { RunV1 } from "./run";

/** The part of a `RunSummary` derived from `run.json`; the API adds `publishedAt` and `featured`. */
export type DerivedSummary = Omit<RunSummary, "publishedAt" | "featured">;

export const SUMMARY_CHARS = 280;

/** Derive the gallery summary of a valid run (docs/API.md `RunSummary`). */
export function summarizeRun(run: RunV1): DerivedSummary {
  const prices = [run.world.initialMarket.price, ...run.rounds.map((round) => round.market.price)];
  const priceStart = prices[0]!;
  const priceEnd = prices[prices.length - 1]!;
  const start = Number(priceStart);
  const actions = run.rounds.flatMap((round) => round.actions);
  return {
    runId: run.runId,
    title: run.scenario.title,
    createdAt: run.createdAt,
    status: run.status,
    stopReason: run.stopReason,
    crowdSize: run.crowd.size,
    rounds: run.rounds.length,
    personaMix: { ...run.crowd.personaMix },
    models: { agents: run.crowd.model.agents, report: run.crowd.model.report },
    hash: run.hash,
    market: {
      symbol: run.world.token.symbol,
      priceStart,
      priceEnd,
      priceChangePct: start > 0 ? round2(((Number(priceEnd) - start) / start) * 100) : 0,
      swaps: actions.filter((a) => a.status === "ok" && (a.kind === "swap_buy" || a.kind === "swap_sell")).length,
      posts: run.rounds.reduce((sum, round) => sum + round.posts.length, 0),
    },
    sparkline: prices.map(Number),
    turningPointRound: run.report.turningPoint?.round ?? null,
    summary: clipCodePoints(run.report.summary, SUMMARY_CHARS),
    ...(run.question
      ? {
          question: {
            text: run.question.text,
            resolvesAt: run.question.resolvesAt,
            expectation: run.question.expectation,
            ...run.question.answers,
          },
        }
      : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** At most `limit` code points; a cut text ends with "…" (counted in the limit). */
export function clipCodePoints(text: string, limit: number): string {
  const points = [...text];
  if (points.length <= limit) return text;
  return `${points.slice(0, limit - 1).join("").trimEnd()}…`;
}
