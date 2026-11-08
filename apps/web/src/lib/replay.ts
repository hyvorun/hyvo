/**
 * The replay engine: turns a run.json into an ordered list of steps and the pool price after
 * every step. Pure and deterministic, so the replay page and its tests share it.
 *
 * A round plays like the engine ran it: the round opens (its injected events), then the posts in
 * creation order, then every agent's market action in execution order. Executed swaps move the
 * pool; their prices are recomputed here from `world.initialMarket` with the router's exact
 * integer formula (chain/src/test-assets/HyvoV2Router.sol `getAmountOut`), so the trace between
 * two recorded round markets is exact, not interpolated.
 */
import type { Action, Post, RunV1 } from "@hyvo/schema";

export type StepKind = "round" | "post" | "action";

export interface Step {
  /** Position in the replay, from 0. */
  index: number;
  /** 1-based round number. */
  round: number;
  kind: StepKind;
  /** Index into `rounds[round - 1].posts` or `.actions`. */
  item: number;
  /** Pool price (quote per token) after this step; a float, for drawing only. */
  price: number;
}

export interface Reserves {
  token: bigint;
  quote: bigint;
}

export interface Replay {
  steps: Step[];
  /** Index of the first step of each round (round n at index n - 1). */
  roundStarts: number[];
  /** Reserves after each round, recomputed from the swaps. */
  roundReserves: Reserves[];
  initialPrice: number;
  /** For each round, the step index of each agent's action (agentId -> step index). */
  actionSteps: Map<string, number>[];
}

const BPS = 10_000n;

/** Exact base units of a canonical decimal string (run.json `Decimal`). */
export function toUnits(value: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  const withFee = amountIn * (BPS - BigInt(feeBps));
  return (withFee * reserveOut) / (reserveIn * BPS + withFee);
}

export function priceOf(reserves: Reserves, tokenDecimals: number, quoteDecimals: number): number {
  const scale = 10 ** (tokenDecimals - quoteDecimals);
  return (Number(reserves.quote) / Number(reserves.token)) * scale;
}

/** Whether `world.token` is the pool's token0 (then reserve0 holds the token). */
export function tokenIsToken0(run: RunV1): boolean {
  return run.world.pools[0]!.token0.toLowerCase() === run.world.token.address.toLowerCase();
}

export function initialReserves(run: RunV1): Reserves {
  const { initialMarket, token, quote } = run.world;
  const first = tokenIsToken0(run);
  const reserve0 = toUnits(initialMarket.reserve0, first ? token.decimals : quote.decimals);
  const reserve1 = toUnits(initialMarket.reserve1, first ? quote.decimals : token.decimals);
  return first ? { token: reserve0, quote: reserve1 } : { token: reserve1, quote: reserve0 };
}

export function isSwap(action: Action): boolean {
  return action.kind === "swap_buy" || action.kind === "swap_sell";
}

export function buildReplay(run: RunV1): Replay {
  const fee = run.world.pools[0]!.feeBps;
  const tokenDecimals = run.world.token.decimals;
  const quoteDecimals = run.world.quote.decimals;
  let reserves = initialReserves(run);
  const initialPrice = priceOf(reserves, tokenDecimals, quoteDecimals);
  let price = initialPrice;

  const steps: Step[] = [];
  const roundStarts: number[] = [];
  const roundReserves: Reserves[] = [];
  const actionSteps: Map<string, number>[] = [];
  const push = (round: number, kind: StepKind, item: number) =>
    steps.push({ index: steps.length, round, kind, item, price });

  for (const round of run.rounds) {
    roundStarts.push(steps.length);
    push(round.n, "round", -1);
    round.posts.forEach((_post, i) => push(round.n, "post", i));
    const byAgent = new Map<string, number>();
    round.actions.forEach((action, i) => {
      if (action.status === "ok" && isSwap(action)) {
        reserves = applySwap(reserves, action, fee, tokenDecimals, quoteDecimals);
        price = priceOf(reserves, tokenDecimals, quoteDecimals);
      }
      byAgent.set(action.agentId, steps.length);
      push(round.n, "action", i);
    });
    actionSteps.push(byAgent);
    roundReserves.push(reserves);
  }
  return { steps, roundStarts, roundReserves, initialPrice, actionSteps };
}

function applySwap(reserves: Reserves, action: Action, fee: number, tokenDecimals: number, quoteDecimals: number): Reserves {
  if (action.kind === "swap_buy") {
    const ethIn = toUnits(action.amountIn!, quoteDecimals);
    const out = amountOut(ethIn, reserves.quote, reserves.token, fee);
    return { token: reserves.token - out, quote: reserves.quote + ethIn };
  }
  const tokensIn = toUnits(action.amountIn!, tokenDecimals);
  const out = amountOut(tokensIn, reserves.token, reserves.quote, fee);
  return { token: reserves.token + tokensIn, quote: reserves.quote - out };
}

/** What a viewer sees at `position`: the round and how far into it the replay is. */
export interface Frame {
  position: number;
  step: Step;
  round: number;
  /** Posts of the current round shown so far. */
  posts: Post[];
  /** Actions of the current round executed so far, in execution order. */
  actions: Action[];
}

export function frameAt(run: RunV1, replay: Replay, position: number): Frame {
  const clamped = Math.max(0, Math.min(position, replay.steps.length - 1));
  const step = replay.steps[clamped]!;
  const round = run.rounds[step.round - 1]!;
  const start = replay.roundStarts[step.round - 1]!;
  const seen = replay.steps.slice(start, clamped + 1);
  const posts = seen.filter((s) => s.kind === "post").map((s) => round.posts[s.item]!);
  const actions = seen.filter((s) => s.kind === "action").map((s) => round.actions[s.item]!);
  return { position: clamped, step, round: step.round, posts, actions };
}

/** Milliseconds a step stays on screen at 1x. Swaps and posts get time; holds fill fast. */
export function stepDuration(run: RunV1, step: Step): number {
  if (step.kind === "round") return 700;
  if (step.kind === "post") return 170;
  const action = run.rounds[step.round - 1]!.actions[step.item]!;
  return isSwap(action) ? 150 : 14;
}
