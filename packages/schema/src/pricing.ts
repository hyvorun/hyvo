/**
 * A run's price (SPEC 8.3, money rule 4), in one place for the API, which charges it, and the web app, which shows it
 * before anything is paid:
 *
 *   estimatedLlmCost = agents x rounds x costPerAgentRoundUsd + reportCostUsd
 *   listed           = max(floorUsd, ceil_step(estimatedLlmCost x multiplier))
 *   price            = listed x (1 - discount), in whole cents
 *
 * A holder's discount comes off the listed price, floor included (founder, 2026-11-09), so it is real for every size:
 * a $1 run costs a holder $0.80.
 *
 * The terms are the API's config (wrangler.jsonc), and `GET /v1/health` says what they are.
 */
import { z } from "zod";

export const PriceTerms = z.strictObject({
  multiplier: z.number().nonnegative(),
  floorUsd: z.number().nonnegative(),
  stepUsd: z.number().positive(),
  costPerAgentRoundUsd: z.number().nonnegative(),
  reportCostUsd: z.number().nonnegative(),
});

export type PriceTerms = z.infer<typeof PriceTerms>;

export interface RunSize {
  agents: number;
  rounds: number;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** What the run's LLM calls are expected to cost, in USD. */
export function estimatedCostUsd(terms: PriceTerms, size: RunSize): number {
  return round6(size.agents * size.rounds * terms.costPerAgentRoundUsd + terms.reportCostUsd);
}

/** The price in USD, in whole cents. `discountBps` is a holder's discount, 0 for everyone else. */
export function runPriceUsd(terms: PriceTerms, size: RunSize, discountBps = 0): number {
  const raw = estimatedCostUsd(terms, size) * terms.multiplier;
  // The epsilon keeps float noise (2.0000000001) from adding a whole step.
  const stepped = Math.ceil(raw / terms.stepUsd - 1e-9) * terms.stepUsd;
  const listed = Math.max(terms.floorUsd, stepped);
  const price = Math.round(listed * (1 - discountBps / 10_000) * 100) / 100;
  // A paid run never costs nothing: a discount cannot take it below one cent.
  return listed > 0 ? Math.max(0.01, price) : 0;
}
