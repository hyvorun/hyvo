import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RunV1 } from "@hyvo/schema";
import { describe, expect, it } from "vitest";
import { buildReplay, frameAt, initialReserves, priceOf, toUnits, tokenIsToken0 } from "../src/lib/replay";

const golden = RunV1.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/golden-run.json", import.meta.url)), "utf8")),
);

function recordedReserves(run: RunV1, n: number) {
  const market = run.rounds[n - 1]!.market;
  const first = tokenIsToken0(run);
  const r0 = toUnits(market.reserve0, first ? run.world.token.decimals : run.world.quote.decimals);
  const r1 = toUnits(market.reserve1, first ? run.world.quote.decimals : run.world.token.decimals);
  return first ? { token: r0, quote: r1 } : { token: r1, quote: r0 };
}

describe("buildReplay on the golden run", () => {
  const replay = buildReplay(golden);

  it("recomputes every round's recorded reserves exactly", () => {
    golden.rounds.forEach((round) => {
      expect(replay.roundReserves[round.n - 1]).toEqual(recordedReserves(golden, round.n));
    });
  });

  it("starts from world.initialMarket", () => {
    const start = initialReserves(golden);
    expect(replay.initialPrice).toBeCloseTo(Number(golden.world.initialMarket.price), 20);
    expect(priceOf(start, 18, 18)).toBe(replay.initialPrice);
  });

  it("orders each round as: round, posts, actions", () => {
    golden.rounds.forEach((round, r) => {
      const start = replay.roundStarts[r]!;
      const end = replay.roundStarts[r + 1] ?? replay.steps.length;
      const kinds = replay.steps.slice(start, end).map((s) => s.kind);
      expect(kinds).toEqual(["round", ...round.posts.map(() => "post"), ...round.actions.map(() => "action")]);
    });
  });

  it("maps each agent to the step of its action in every round", () => {
    golden.rounds.forEach((round, r) => {
      const steps = replay.actionSteps[r]!;
      expect(steps.size).toBe(golden.crowd.size);
      round.actions.forEach((action, i) => {
        expect(replay.steps[steps.get(action.agentId)!]).toMatchObject({ kind: "action", item: i });
      });
    });
  });

  it("ends each round at the recorded price", () => {
    golden.rounds.forEach((round, r) => {
      const last = (replay.roundStarts[r + 1] ?? replay.steps.length) - 1;
      expect(replay.steps[last]!.price).toBeCloseTo(Number(round.market.price), 18);
    });
  });
});

describe("frameAt", () => {
  const replay = buildReplay(golden);

  it("shows the posts and actions of the current round up to the position", () => {
    const start = replay.roundStarts[2]!;
    const round = golden.rounds[2]!;
    const atStart = frameAt(golden, replay, start);
    expect(atStart).toMatchObject({ round: 3, posts: [], actions: [] });
    const afterPosts = frameAt(golden, replay, start + round.posts.length);
    expect(afterPosts.posts).toEqual(round.posts);
    expect(afterPosts.actions).toEqual([]);
    const end = frameAt(golden, replay, start + round.posts.length + round.actions.length);
    expect(end.actions).toEqual(round.actions);
  });

  it("clamps out-of-range positions", () => {
    expect(frameAt(golden, replay, -5).position).toBe(0);
    expect(frameAt(golden, replay, 1e9).position).toBe(replay.steps.length - 1);
  });
});

describe("toUnits", () => {
  it("converts canonical decimals exactly", () => {
    expect(toUnits("0", 18)).toBe(0n);
    expect(toUnits("1", 18)).toBe(10n ** 18n);
    expect(toUnits("0.05", 18)).toBe(5n * 10n ** 16n);
    expect(toUnits("123.000000000000000001", 18)).toBe(123n * 10n ** 18n + 1n);
    expect(() => toUnits("0.1234567", 6)).toThrow();
  });
});
