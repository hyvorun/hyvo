import { RUN_PERSONAS, type RunV1 } from "@hyvo/schema";
import { useId, useMemo } from "react";
import { formatScaled, personaLabel, type PriceUnit } from "../lib/format";
import { isSwap, type Replay } from "../lib/replay";
import styles from "./ReplayChart.module.css";

interface Props {
  run: RunV1;
  replay: Replay;
  unit: PriceUnit;
  position: number;
  width: number;
  /** The price alone, without the crowd raster below it. */
  horizon?: boolean;
  onSeek: (position: number) => void;
}

interface Row {
  agentId: string;
  y: number;
}

/**
 * The pool price over every step, and below it the crowd raster, one row per agent and one mark per
 * trade at the moment it executed. Both share the time axis, so a price move lines up with the
 * trades that caused it.
 */
export function ReplayChart({ run, replay, unit, position, width, horizon = false, onSeek }: Props) {
  const id = useId();
  const narrow = width < 480;
  const gutter = horizon || narrow ? 58 : 84;
  const left = 2;
  const plotWidth = Math.max(10, width - gutter - left);
  const traceHeight = narrow ? 120 : 176;
  // A row can be thinner than a pixel: a very large crowd reads as a density, in a raster of at most 420 px.
  const rowHeight = Math.min(narrow ? 3.5 : 4.2, Math.max(230 / run.crowd.size, Math.min(1.5, 420 / run.crowd.size)));
  const groupGap = 6;
  const top = 20;
  const rasterTop = top + traceHeight + 18;
  const n = replay.steps.length;
  const x = (step: number) => left + (n <= 1 ? 0 : (step / (n - 1)) * plotWidth);

  const layout = useMemo(() => {
    const rows: Row[] = [];
    const groups: { persona: string; count: number; y: number; height: number }[] = [];
    let y = rasterTop;
    if (!horizon) {
      for (const persona of RUN_PERSONAS) {
        const members = run.crowd.agents.filter((a) => a.persona === persona);
        if (members.length === 0) continue;
        groups.push({ persona, count: members.length, y, height: members.length * rowHeight });
        for (const agent of members) {
          rows.push({ agentId: agent.agentId, y });
          y += rowHeight;
        }
        y += groupGap;
      }
    }
    return { rows, groups, bottom: horizon ? top + traceHeight : y - groupGap };
  }, [run, rowHeight, rasterTop, horizon, traceHeight]);

  const prices = useMemo(() => [replay.initialPrice, ...replay.steps.map((s) => s.price)], [replay]);
  const scale = useMemo(() => priceScale(prices), [prices]);
  const ticks = useMemo(() => priceTicks(prices), [prices]);
  const yPrice = (p: number) => top + (1 - scale(p)) * traceHeight;

  // This is drawn on every frame of the replay, so it holds only the points where the price moves. Most of a large crowd's steps
  // are holds, which leave the line flat.
  const trace = useMemo(() => {
    const point = (index: number, price: number) => ({ index, at: `${x(index).toFixed(1)},${yPrice(price).toFixed(1)}` });
    const points: { index: number; at: string }[] = [];
    let previous: (typeof replay.steps)[number] | null = null;
    for (const step of replay.steps) {
      if (previous === null) points.push(point(step.index, step.price));
      else if (step.price !== previous.price) {
        if (points.at(-1)!.index !== previous.index) points.push(point(previous.index, previous.price));
        points.push(point(step.index, step.price));
      }
      previous = step;
    }
    return points;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- x and yPrice are made from these
  }, [replay, plotWidth, scale, traceHeight, n]);
  const path = (upTo: number) => {
    let low = 0;
    let high = trace.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (trace[middle]!.index <= upTo) low = middle + 1;
      else high = middle;
    }
    const line = trace.slice(0, low).map((point, i) => `${i === 0 ? "M" : "L"}${point.at}`).join("");
    return `${line}L${x(upTo).toFixed(1)},${yPrice(replay.steps[upTo]!.price).toFixed(1)}`;
  };

  const rowOf = useMemo(() => new Map(layout.rows.map((r) => [r.agentId, r.y])), [layout]);
  const marks = useMemo(() => (horizon ? [] : rasterMarks(run, replay)), [run, replay, horizon]);
  const height = layout.bottom + 24;
  const current = replay.steps[position]!;
  const turning = run.report.turningPoint?.round ?? null;
  const markWidth = Math.max(2, Math.min(4, (plotWidth / n) * 1.6));

  // Every mark, drawn once. The replay uncovers them with a clip, so a frame does not touch thousands of elements.
  const markLayer = useMemo(
    () =>
      marks.map((mark) => {
        const y = rowOf.get(mark.agentId);
        if (y === undefined) return null;
        const cx = x(mark.step);
        if (mark.type === "post") {
          return <circle key={mark.key} className={styles.post} cx={cx} cy={y + rowHeight / 2} r={Math.max(0.9, rowHeight / 3)} />;
        }
        if (mark.type === "check") {
          return <rect key={mark.key} className={styles.check} x={cx - 0.75} y={y + rowHeight * 0.25} width={1.5} height={Math.max(0.5, rowHeight * 0.5)} />;
        }
        return (
          <rect
            key={mark.key}
            className={`${mark.type === "buy" ? styles.buy : styles.sell} ${mark.reverted ? styles.reverted : ""}`}
            x={cx - markWidth / 2}
            y={y + 0.5}
            width={markWidth}
            height={Math.max(1, rowHeight - 1)}
            rx={0.6}
          />
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- x is made from these
    [marks, rowOf, rowHeight, markWidth, plotWidth, n],
  );
  const baseline = top + traceHeight;

  const seekFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left - left) / plotWidth;
    onSeek(Math.round(Math.max(0, Math.min(1, ratio)) * (n - 1)));
  };

  if (width === 0) return <div style={{ height: horizon ? traceHeight + 44 : traceHeight + 240 }} />;

  const line = path(position);
  const area = `${line}L${x(position).toFixed(1)},${baseline}L${x(0).toFixed(1)},${baseline}Z`;

  return (
    <svg
      className={styles.chart}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={
        horizon
          ? `Price trace, ${run.rounds.length} rounds`
          : `Price trace and crowd raster, ${run.rounds.length} rounds, ${run.crowd.size.toLocaleString("en-US")} agents`
      }
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        seekFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) seekFromPointer(event);
      }}
    >
      <defs>
        <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.14" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-played`}>
          <rect x={0} y={0} width={x(position) + markWidth / 2} height={height} />
        </clipPath>
      </defs>

      {turning !== null && (
        <g className={styles.turning}>
          <rect
            x={x(replay.roundStarts[turning - 1]!)}
            y={top - 16}
            rx={3}
            width={x((replay.roundStarts[turning] ?? n) - 1) - x(replay.roundStarts[turning - 1]!)}
            height={layout.bottom - top + 16}
          />
          <text x={x(replay.roundStarts[turning - 1]!) + 6} y={top - 5}>
            Turning point
          </text>
        </g>
      )}

      {replay.roundStarts.map((start, r) => (
        <g key={start} className={styles.round}>
          <line x1={x(start)} x2={x(start)} y1={top} y2={layout.bottom} />
          <text x={x(start) + 3} y={layout.bottom + 16}>
            {narrow && r % 2 === 1 ? "" : `R${r + 1}`}
          </text>
        </g>
      ))}

      {ticks.map((t) => (
        <g key={t} className={styles.tick}>
          <line x1={left} x2={left + plotWidth} y1={yPrice(t)} y2={yPrice(t)} />
          <text x={left + plotWidth + 8} y={yPrice(t) + 4}>
            {formatScaled(t, unit)}
          </text>
        </g>
      ))}

      {run.scenario.injectedEvents.map((event) => {
        const at = x(replay.roundStarts[event.round - 1] ?? 0);
        return (
          <g key={`${event.round}-${event.text}`} className={styles.event}>
            <line x1={at} x2={at} y1={top} y2={baseline} />
            <path d={`M${at},${top - 1} l3.5,3.5 l-3.500,3.500 l-3.500,-3.500 z`} />
            <title>{`Round ${event.round} event: ${event.text}`}</title>
          </g>
        );
      })}

      <path className={styles.ghost} d={path(n - 1)} />
      <path className={styles.area} d={area} fill={`url(#${id}-area)`} />
      {/* pathLength lets the line draw itself in once, whatever its length; playback is unchanged. */}
      <path className={styles.trace} d={line} pathLength={1} />

      {!horizon && (
        <g className={styles.groups}>
          {layout.groups.map((g) => (
            <text key={g.persona} x={left + plotWidth + 8} y={g.y + Math.min(g.height, 22) / 2 + 4}>
              {narrow ? personaLabel(g.persona, g.count).split(" ")[0] : personaLabel(g.persona, g.count)}
            </text>
          ))}
          {rowHeight >= 1 &&
            layout.rows.map((row, i) => (
              <line key={row.agentId} className={i % 2 ? styles.rowOdd : styles.row} x1={left} x2={left + plotWidth} y1={row.y + rowHeight / 2} y2={row.y + rowHeight / 2} />
            ))}
        </g>
      )}

      <g className={styles.marks} clipPath={`url(#${id}-played)`}>
        {markLayer}
      </g>

      <g className={styles.playhead}>
        <line x1={x(position)} x2={x(position)} y1={top - 6} y2={layout.bottom + 2} />
        <circle className={styles.head} cx={x(position)} cy={yPrice(current.price)} r={3.5} />
      </g>
    </svg>
  );
}

type Mark =
  | { key: string; type: "post"; agentId: string; step: number }
  | { key: string; type: "check"; agentId: string; step: number }
  | { key: string; type: "buy" | "sell"; agentId: string; step: number; reverted: boolean };

function rasterMarks(run: RunV1, replay: Replay): Mark[] {
  const marks: Mark[] = [];
  for (const step of replay.steps) {
    const round = run.rounds[step.round - 1]!;
    if (step.kind === "post") {
      const post = round.posts[step.item]!;
      marks.push({ key: `p${step.index}`, type: "post", agentId: post.agentId, step: step.index });
    } else if (step.kind === "action") {
      const action = round.actions[step.item]!;
      if (action.kind === "check_market") {
        marks.push({ key: `k${step.index}`, type: "check", agentId: action.agentId, step: step.index });
      } else if (isSwap(action) && action.status !== "invalid") {
        marks.push({
          key: `s${step.index}`,
          type: action.kind === "swap_buy" ? "buy" : "sell",
          agentId: action.agentId,
          step: step.index,
          reverted: action.status === "reverted",
        });
      }
    }
  }
  return marks;
}

/** 0..1 position of a price: logarithmic when prices span more than 4x, else linear with room. */
function priceScale(prices: number[]): (p: number) => number {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (min > 0 && max / min > 4) {
    const lo = Math.log(min);
    const hi = Math.log(max);
    return (p) => (Math.log(p) - lo) / (hi - lo || 1);
  }
  const pad = (max - min) * 0.12 || max * 0.05 || 1;
  return (p) => (p - (min - pad)) / (max - min + 2 * pad);
}

function priceTicks(prices: number[]): number[] {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (min === max) return [min];
  return [min, (min + max) / 2, max];
}
