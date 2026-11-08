/**
 * What a paid run plays: the scenario a user submits and the job spec the runner receives
 * (docs/API.md, "Quotes" and "Runner jobs"). Limits mirror the engine's scenario rules
 * (engine/hyvo/scenarios), so a quote the API accepts is a job the engine can play.
 */
import { z } from "zod";
import { CloneProfile } from "./clone";
import { Address, PERSONAS, RunId, Timestamp } from "./run";

export const JOB_SPEC_VERSION = 1;
export const MAX_TITLE_CHARS = 200;
export const MAX_SEED_CHARS = 4000;
export const MAX_EVENT_CHARS = 500;
export const MAX_EVENTS = 50;
export const MAX_EVENTS_PER_ROUND = 5;

function codePoints(s: string): number {
  return [...s].length;
}

function text(min: number, max: number) {
  return z.string().refine((s) => {
    const length = codePoints(s);
    return length >= min && length <= max;
  }, `must be ${min} to ${max} characters long`);
}

/**
 * A decimal string with at most 18 decimals (no exponent). The minimum keeps the pool's first mint
 * above the pair's locked liquidity, which two near-zero amounts would not reach.
 */
function amount(min: number, max: number) {
  return z
    .string()
    .regex(/^[0-9]+(\.[0-9]{1,18})?$/, "must be a decimal number such as 5 or 0.25")
    .refine((s) => Number(s) >= min && Number(s) <= max, `must be from ${min} to ${max}`);
}

export const MarketInput = z.strictObject({
  tokenSymbol: z
    .string()
    .regex(/^[A-Z0-9]{1,11}$/, "must be 1-11 uppercase letters or digits")
    .optional(),
  tokenName: text(1, 64).optional(),
  liquidityEth: amount(0.001, 1_000_000).optional(),
  liquidityTokens: amount(0.001, 1_000_000_000_000_000).optional(),
  feeBps: z.int().min(0).max(1000).optional(),
});

export const ScenarioEvent = z.strictObject({
  round: z.int().min(1),
  // Text of only invisible characters would be empty once the engine sanitizes it.
  text: text(1, MAX_EVENT_CHARS).refine((s) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(s), "must have visible text"),
});

/** A scenario as a user submits it; the engine sanitizes the text again before use. */
export const ScenarioInput = z
  .strictObject({
    title: text(1, MAX_TITLE_CHARS).refine(
      (s) => /[\p{L}\p{N}]/u.test(s),
      "must contain a letter or a digit",
    ),
    seedText: text(0, MAX_SEED_CHARS),
    events: z.array(ScenarioEvent).max(MAX_EVENTS).default([]),
    market: MarketInput.optional(),
  })
  .superRefine((scenario, ctx) => {
    const perRound = new Map<number, number>();
    for (const event of scenario.events) {
      const count = (perRound.get(event.round) ?? 0) + 1;
      perRound.set(event.round, count);
      if (count === MAX_EVENTS_PER_ROUND + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["events"],
          message: `round ${event.round} has more than ${MAX_EVENTS_PER_ROUND} events`,
        });
      }
    }
  });

/** A question the crowd answers at the end of the run. The API bounds the date and holds the text to the copy rules. */
export const QuestionInput = z.strictObject({
  text: text(10, 300).refine((s) => /[\p{L}\p{N}]/u.test(s), "must contain a letter or a digit"),
  resolvesAt: Timestamp,
});

/** A past moment of a real pool, on Robinhood Chain. */
export const RewindInput = z.strictObject({
  pool: Address,
  block: z.int().positive(),
  hours: z.number().min(1).max(72),
});

/** Persona counts, each optional (missing = 0). */
export const MixInput = z.partialRecord(z.enum(PERSONAS), z.int().min(0));

/** The job spec: fixed when the run is ordered, played as-is by the runner. */
export const JobSpec = z.strictObject({
  version: z.literal(JOB_SPEC_VERSION),
  scenario: z.strictObject({
    title: z.string(),
    seedText: z.string(),
    events: z.array(ScenarioEvent),
    market: MarketInput.nullable(),
  }),
  agents: z.int().min(1),
  rounds: z.int().min(1),
  mix: MixInput.nullable(),
  batchSize: z.int().min(1),
  maxCostUsd: z.number().nonnegative(),
  maxLlmCalls: z.int().nonnegative(),
  seed: z.int().nonnegative().nullable(),
  question: QuestionInput.nullable().optional(),
  /** A wallet's numbers, when one agent of the crowd plays them. */
  clone: CloneProfile.nullable().optional(),
  /** A past moment of a real pool. The scenario's one event is what differs. */
  rewind: RewindInput.nullable().optional(),
});

/** `GET /internal/jobs/next` → `{ job }`. */
export const RunnerJob = z.strictObject({
  runId: RunId,
  leaseId: z.string().regex(/^lease_[A-Za-z0-9_-]{16,64}$/),
  attempt: z.int().min(1),
  heartbeatIntervalS: z.number().positive(),
  timeoutS: z.number().positive(),
  spec: JobSpec,
});

export type MarketInput = z.infer<typeof MarketInput>;
export type ScenarioEvent = z.infer<typeof ScenarioEvent>;
export type ScenarioInput = z.infer<typeof ScenarioInput>;
export type QuestionInput = z.infer<typeof QuestionInput>;
export type MixInput = z.infer<typeof MixInput>;
export type JobSpec = z.infer<typeof JobSpec>;
export type RunnerJob = z.infer<typeof RunnerJob>;

export type RewindInput = z.infer<typeof RewindInput>;
