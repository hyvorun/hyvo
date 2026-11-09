/**
 * Quotes (SPEC 8.3, money rule 4): estimatedLlmCost = agents x rounds x COST_PER_AGENT_ROUND_USD
 * + REPORT_COST_USD; price = max(PRICE_FLOOR_USD, ceil_step(estimatedLlmCost x PRICE_MULTIPLIER x
 * (1 - discount))). Each run's LLM budget is the estimate x BUDGET_HEADROOM, never more than the
 * price, so a paid run cannot spend more than it brought in. The formula itself is `runPriceUsd` in
 * @hyvo/schema, which the web app uses to show a price before anything is paid.
 */
import type { JobSpec, MixInput, QuestionInput, ScenarioInput } from "@hyvo/schema";
import { estimatedCostUsd as estimateFromTerms, JOB_SPEC_VERSION, runPriceUsd } from "@hyvo/schema";
import { parseUnits } from "viem";
import type { Config, Token } from "./config";
import { ApiError } from "./errors";

/** Report calls the engine may make (summary, rewrite, retry). */
const REPORT_CALLS = 3;

export interface RunSize {
  agents: number;
  rounds: number;
}

export interface Quote {
  estimatedCostUsd: number;
  priceUsd: number;
  maxCostUsd: number;
  maxLlmCalls: number;
  discountBps: number;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function checkSize(cfg: Config, size: RunSize): void {
  const { minAgents, maxAgents, minRounds, maxRounds, maxRunDecisions } = cfg.sizes;
  if (size.agents < minAgents || size.agents > maxAgents) {
    throw new ApiError(400, "bad_request", `agents must be from ${minAgents} to ${maxAgents}`);
  }
  if (size.rounds < minRounds || size.rounds > maxRounds) {
    throw new ApiError(400, "bad_request", `rounds must be from ${minRounds} to ${maxRounds}`);
  }
  if (size.agents * size.rounds > maxRunDecisions) {
    throw new ApiError(400, "bad_request", `agents x rounds must be at most ${maxRunDecisions}, because a run's file has a size limit`);
  }
}

/** Measured on a 1,000 x 10 run: 0.05 s a decision on the offline model, plus the model's own time at four calls at once. */
const SECONDS_PER_DECISION = 0.2;

/** A run's time limit: the queue's, or longer for a very large crowd, which would otherwise stop early and be paid for in full. */
export function jobTimeoutFor(cfg: Config, size: RunSize): number {
  return Math.max(cfg.queue.jobTimeoutS, Math.ceil(size.agents * size.rounds * SECONDS_PER_DECISION));
}

export function estimateCostUsd(cfg: Config, size: RunSize): number {
  return estimateFromTerms(cfg.pricing, size);
}

function maxLlmCalls(cfg: Config, size: RunSize): number {
  const decisionCalls = Math.ceil(size.agents / cfg.sizes.batchSize) * size.rounds;
  return Math.ceil((decisionCalls + REPORT_CALLS) * Math.max(1, cfg.pricing.budgetHeadroom));
}

/** A paid quote. */
export function quoteRun(cfg: Config, size: RunSize, discountBps = 0): Quote {
  const p = cfg.pricing;
  const estimatedCostUsd = estimateCostUsd(cfg, size);
  const priceUsd = runPriceUsd(p, size, discountBps);
  return {
    estimatedCostUsd,
    priceUsd,
    maxCostUsd: round6(Math.min(estimatedCostUsd * p.budgetHeadroom, priceUsd)),
    maxLlmCalls: maxLlmCalls(cfg, size),
    discountBps,
  };
}

/** A holder free run: no price; the treasury covers the LLM budget. */
export function creditRun(cfg: Config, size: RunSize): Quote {
  const estimatedCostUsd = estimateCostUsd(cfg, size);
  return {
    estimatedCostUsd,
    priceUsd: 0,
    maxCostUsd: round6(estimatedCostUsd * cfg.pricing.budgetHeadroom),
    maxLlmCalls: maxLlmCalls(cfg, size),
    discountBps: 10_000,
  };
}

/** The most agents x rounds whose budget fits the daily cap (what `checkDailyCap` lets through). */
export function maxDecisions(cfg: Config): number {
  const { maxAgents, maxRounds, maxRunDecisions } = cfg.sizes;
  const p = cfg.pricing;
  const room = cfg.queue.dailyCapUsd / Math.max(p.budgetHeadroom, 1e-9) - p.reportCostUsd;
  if (room <= 0) return 0;
  const largest = Math.min(maxAgents * maxRounds, maxRunDecisions);
  return Math.min(largest, p.costPerAgentRoundUsd > 0 ? Math.floor(room / p.costPerAgentRoundUsd) : largest);
}

/** A run whose budget alone passes the daily cap could never start: refuse it before it is paid. */
export function checkDailyCap(cfg: Config, quote: Quote): void {
  if (quote.maxCostUsd > cfg.queue.dailyCapUsd) {
    throw new ApiError(400, "over_daily_cap", "a run this size does not fit the daily limit; choose a smaller crowd or fewer rounds");
  }
}

/** The token amount for a USD price (USDG is a dollar stablecoin). */
export function tokenAmount(token: Token, priceUsd: number): bigint {
  return parseUnits(priceUsd.toFixed(2), token.decimals);
}

export function buildSpec(
  cfg: Config,
  request: { scenario: ScenarioInput; agents: number; rounds: number; mix?: MixInput | null | undefined; question?: QuestionInput | undefined },
  quote: Quote,
): JobSpec {
  const { scenario } = request;
  return {
    version: JOB_SPEC_VERSION,
    scenario: {
      title: scenario.title,
      seedText: scenario.seedText,
      events: scenario.events,
      market: scenario.market ?? null,
    },
    agents: request.agents,
    rounds: request.rounds,
    mix: request.mix ?? null,
    batchSize: cfg.sizes.batchSize,
    maxCostUsd: quote.maxCostUsd,
    // One more call per 25 agents, for their answers.
    maxLlmCalls: quote.maxLlmCalls + (request.question ? Math.ceil(request.agents / 25) : 0),
    seed: null,
    ...(request.question ? { question: request.question } : {}),
  };
}
