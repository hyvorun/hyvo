/**
 * The crowd as a chart: one dot per agent, in one row per kind of trader. A dot fills by what its
 * agent holds, recomputed from the run's own swaps at any step of the replay. Pure and
 * deterministic, so the replay and its tests share it.
 */
import { RUN_PERSONAS, type RunV1 } from "@hyvo/schema";
import { isSwap, type Replay } from "./replay";

export interface CrowdCell {
  agentId: string;
  persona: string;
  /** Position in the grid, in dots. */
  col: number;
  row: number;
}

export interface CrowdGroup {
  persona: string;
  count: number;
  firstRow: number;
  rows: number;
}

export interface CrowdLayout {
  cells: CrowdCell[];
  groups: CrowdGroup[];
  columns: number;
  rows: number;
}

export interface CrowdMember {
  agentId: string;
  persona: string;
}

/** The largest persona on one row while it fits; a big crowd wraps into an even block. */
function columnsFor(size: number, largest: number): number {
  return largest <= 24 ? Math.max(10, largest) : Math.ceil(Math.sqrt(size * 3));
}

export function crowdLayout(members: readonly CrowdMember[]): CrowdLayout {
  const known = RUN_PERSONAS as readonly string[];
  const order = [...known, ...new Set(members.map((m) => m.persona).filter((p) => !known.includes(p)))];
  const parts = order
    .map((persona) => ({ persona, agents: members.filter((m) => m.persona === persona) }))
    .filter((part) => part.agents.length > 0);
  const columns = columnsFor(members.length, Math.max(0, ...parts.map((p) => p.agents.length)));

  const cells: CrowdCell[] = [];
  const groups: CrowdGroup[] = [];
  let row = 0;
  for (const { persona, agents } of parts) {
    const rows = Math.ceil(agents.length / columns);
    groups.push({ persona, count: agents.length, firstRow: row, rows });
    agents.forEach((agent, i) => {
      cells.push({ agentId: agent.agentId, persona, col: i % columns, row: row + Math.floor(i / columns) });
    });
    row += rows;
  }
  return { cells, groups, columns, rows: row };
}

/** A crowd of `size` before it exists, in the engine's default mix of personas. */
export function previewLayout(size: number): CrowdLayout {
  const shares: [string, number][] = [
    ["sniper", 0.2],
    ["holder", 0.3],
    ["panic_seller", 0.2],
    ["skeptic", 0.3],
  ];
  const members: CrowdMember[] = [];
  let made = 0;
  shares.forEach(([persona, share], i) => {
    const count = i === shares.length - 1 ? size - made : Math.round(size * share);
    for (let n = 0; n < count; n++) members.push({ agentId: `${persona}-${n}`, persona });
    made += count;
  });
  return crowdLayout(members);
}

export type CrowdEventKind = "buy" | "sell" | "reverted" | "check" | "post";

export interface CrowdEvent {
  /** Index into `layout.cells`. */
  cell: number;
  kind: CrowdEventKind;
  /** Tokens this step adds to the agent's holding (negative for a sale). */
  tokens: number;
}

export interface CrowdTimeline {
  /** Tokens each cell holds before the run. */
  start: Float64Array;
  /** The largest holding of any agent at any step: the level of a full dot. */
  max: number;
  /** What happened at each replay step, by step index. */
  events: (CrowdEvent | null)[];
}

export function buildCrowdTimeline(run: RunV1, replay: Replay, layout: CrowdLayout): CrowdTimeline {
  const cellOf = new Map(layout.cells.map((cell, i) => [cell.agentId, i]));
  const start = new Float64Array(layout.cells.length);
  for (const agent of run.crowd.agents) {
    const cell = cellOf.get(agent.agentId);
    if (cell !== undefined) start[cell] = Number(agent.startTokens);
  }
  const events: (CrowdEvent | null)[] = [];
  const held = start.slice();
  let max = Math.max(...held, 0);
  for (const step of replay.steps) {
    const round = run.rounds[step.round - 1]!;
    let event: CrowdEvent | null = null;
    if (step.kind === "post") {
      const cell = cellOf.get(round.posts[step.item]!.agentId);
      if (cell !== undefined) event = { cell, kind: "post", tokens: 0 };
    } else if (step.kind === "action") {
      const action = round.actions[step.item]!;
      const cell = cellOf.get(action.agentId);
      if (cell !== undefined) {
        if (action.kind === "check_market") {
          event = { cell, kind: "check", tokens: 0 };
        } else if (isSwap(action) && action.status === "reverted") {
          event = { cell, kind: "reverted", tokens: 0 };
        } else if (isSwap(action) && action.status === "ok") {
          const buy = action.kind === "swap_buy";
          const tokens = buy ? Number(action.amountOut) : -Number(action.amountIn);
          event = { cell, kind: buy ? "buy" : "sell", tokens };
          held[cell] = Math.max(0, held[cell]! + tokens);
          max = Math.max(max, held[cell]!);
        }
      }
    }
    events.push(event);
  }
  return { start, max, events };
}

/** Tokens each cell holds after step `position`. */
export function holdingsAt(timeline: CrowdTimeline, position: number): Float64Array {
  const held = timeline.start.slice();
  for (let i = 0; i <= position && i < timeline.events.length; i++) {
    const event = timeline.events[i];
    if (event && event.tokens !== 0) held[event.cell] = Math.max(0, held[event.cell]! + event.tokens);
  }
  return held;
}

/** How full a dot looks, 0..1. The root lets small holders show; any holding shows at all. */
export function levelOf(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0;
  return Math.min(1, 0.12 + 0.88 * Math.sqrt(tokens / max));
}
