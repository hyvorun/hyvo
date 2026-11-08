import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RunV1, type RunV1 as Run } from "@hyvo/schema";
import { describe, expect, it } from "vitest";
import { buildCrowdTimeline, crowdLayout, holdingsAt, levelOf, previewLayout } from "../src/lib/crowd";
import { buildReplay } from "../src/lib/replay";

const golden: Run = RunV1.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/golden-run.json", import.meta.url)), "utf8")),
);

describe("crowdLayout", () => {
  const layout = crowdLayout(golden.crowd.agents);

  it("gives every agent one dot, and no two dots one place", () => {
    expect(layout.cells.map((c) => c.agentId).sort()).toEqual(golden.crowd.agents.map((a) => a.agentId).sort());
    expect(new Set(layout.cells.map((c) => `${c.col},${c.row}`)).size).toBe(layout.cells.length);
  });

  it("keeps each agent in its persona's rows, inside the grid", () => {
    const persona = new Map(golden.crowd.agents.map((a) => [a.agentId, a.persona]));
    for (const cell of layout.cells) {
      expect(cell.persona).toBe(persona.get(cell.agentId));
      const group = layout.groups.find((g) => g.persona === cell.persona)!;
      expect(cell.row).toBeGreaterThanOrEqual(group.firstRow);
      expect(cell.row).toBeLessThan(group.firstRow + group.rows);
      expect(cell.col).toBeLessThan(layout.columns);
    }
    expect(layout.groups.reduce((sum, g) => sum + g.count, 0)).toBe(golden.crowd.size);
  });

  it("gives a small crowd one row per persona and wraps a big one", () => {
    expect(layout.rows).toBe(layout.groups.length);
    const big = previewLayout(500);
    expect(big.rows).toBeGreaterThan(big.groups.length);
    expect(big.columns).toBeLessThan(150);
  });

  it("draws a crowd of any allowed size before it exists", () => {
    for (const size of [10, 30, 50, 80, 137, 500]) expect(previewLayout(size).cells).toHaveLength(size);
  });
});

describe("the crowd's timeline", () => {
  const replay = buildReplay(golden);
  const layout = crowdLayout(golden.crowd.agents);
  const timeline = buildCrowdTimeline(golden, replay, layout);
  const cellOf = new Map(layout.cells.map((c, i) => [c.agentId, i]));

  it("starts from what each agent holds", () => {
    for (const agent of golden.crowd.agents) {
      expect(timeline.start[cellOf.get(agent.agentId)!]).toBe(Number(agent.startTokens));
    }
  });

  it("has one entry per replay step, and marks every swap and post of the run", () => {
    expect(timeline.events).toHaveLength(replay.steps.length);
    const swaps = golden.rounds.flatMap((r) => r.actions).filter((a) => a.status === "ok" && a.kind.startsWith("swap"));
    expect(timeline.events.filter((e) => e?.kind === "buy" || e?.kind === "sell")).toHaveLength(swaps.length);
    expect(timeline.events.filter((e) => e?.kind === "post")).toHaveLength(golden.rounds.flatMap((r) => r.posts).length);
  });

  it("holds what the run's swaps say at the end, and never less than nothing", () => {
    const held = holdingsAt(timeline, replay.steps.length - 1);
    for (const agent of golden.crowd.agents) {
      let expected = Number(agent.startTokens);
      for (const action of golden.rounds.flatMap((r) => r.actions)) {
        if (action.agentId !== agent.agentId || action.status !== "ok") continue;
        if (action.kind === "swap_buy") expected += Number(action.amountOut);
        if (action.kind === "swap_sell") expected = Math.max(0, expected - Number(action.amountIn));
      }
      expect(held[cellOf.get(agent.agentId)!]).toBeCloseTo(expected, 3);
    }
    for (const value of held) expect(value).toBeGreaterThanOrEqual(0);
    expect(Math.max(...held)).toBeLessThanOrEqual(timeline.max);
  });

  it("fills a dot by its holding: empty at nothing, full at the most anyone held", () => {
    expect(levelOf(0, timeline.max)).toBe(0);
    expect(levelOf(timeline.max, timeline.max)).toBe(1);
    expect(levelOf(timeline.max / 100, timeline.max)).toBeGreaterThan(0.12);
    expect(levelOf(5, 0)).toBe(0);
  });
});
