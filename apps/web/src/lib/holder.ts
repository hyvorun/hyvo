/*
 * What holding HYVO is set to bring, shown on the token page and the home page. These mirror
 * apps/api/wrangler.jsonc (FREE_RUNS_PER_MONTH, FREE_RUN_MAX_AGENTS, FREE_RUN_MAX_ROUNDS,
 * HOLDER_DISCOUNT_BPS) and apps/api/src/lib/holder.ts. They are drafts until the launch; change
 * them together.
 */
export const HOLDER_DRAFT = { freeRuns: 2, freeAgents: 50, freeRounds: 10, discountPct: 20 } as const;
