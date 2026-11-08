import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { holdingsAt, levelOf, type CrowdLayout, type CrowdTimeline } from "../lib/crowd";
import { personaLabel } from "../lib/format";
import styles from "./Crowd.module.css";
import { prefersReducedMotion } from "./use-playback";

interface Props {
  layout: CrowdLayout;
  /** The run behind the chart. Without one it idles: `fill` of the dots hold something. */
  timeline?: CrowdTimeline;
  position?: number;
  fill?: number;
  ariaLabel: string;
  maxPitch?: number;
  /** Names each row. Off for a small picture of a crowd. */
  labels?: boolean;
  /** Writes what each kind of trader holds, at the end of its row. */
  formatHeld?: (tokens: number) => string;
  /** What a hovered dot shows. */
  tipFor?: (cell: number, tokens: number) => ReactNode;
}

interface Palette {
  dot: string;
  line: string;
  held: string;
  buy: string;
  sell: string;
  post: string;
  ink: string;
  ink3: string;
}

interface Anim {
  level: Float32Array;
  target: Float32Array;
  held: Float64Array;
  buy: Float32Array;
  sell: Float32Array;
  ring: Float32Array;
  pop: Float32Array;
  popV: Float32Array;
  born: Float64Array;
}

const LABEL_WIDTH = 118;
const LABEL_MARGIN = 16;
const LABEL_LINE = 20;
const HELD_WIDTH = 72;
/** Below this radius a fill line cannot be read, so a dot brightens with what it holds. */
const SMALL_DOT = 4.5;
const APPEAR_MS = 460;

function makeAnim(n: number, previous: Anim | null, now: number, entrance: boolean): Anim {
  const anim: Anim = {
    level: new Float32Array(n),
    target: new Float32Array(n),
    held: new Float64Array(n),
    buy: new Float32Array(n),
    sell: new Float32Array(n),
    ring: new Float32Array(n).fill(1),
    pop: new Float32Array(n),
    popV: new Float32Array(n),
    born: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const kept = previous !== null && i < previous.level.length;
    anim.level[i] = kept ? previous.level[i]! : 0;
    // Dots already on screen stay; new ones appear in reading order.
    anim.born[i] = kept ? previous.born[i]! : entrance ? now + Math.min(i, 120) * 9 : -1e9;
  }
  return anim;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  return {
    dot: get("--dot"),
    line: get("--dot-line"),
    held: get("--accent"),
    buy: get("--buy"),
    sell: get("--sell"),
    post: get("--post"),
    ink: get("--ink-2"),
    ink3: get("--ink-3"),
  };
}

/** The same pseudo-random value for the same dot. */
function seeded(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The crowd now: one dot per agent, one row per kind of trader. A dot fills by what its agent holds.
 * A purchase washes it and fills it, a sale washes it and drains it, a post sends one thin ring out.
 * Everything is drawn from the run itself (lib/crowd.ts).
 */
export function Crowd({ layout, timeline, position = 0, fill = 0.5, ariaLabel, maxPitch = 22, labels = true, formatHeld, tipFor }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useMemo(prefersReducedMotion, []);
  const [tip, setTip] = useState<{ cell: number; left: number; top: number } | null>(null);

  // What the frame loop reads; React never re-renders for animation.
  const live = useRef({
    anim: null as Anim | null,
    layout,
    width: 0,
    height: 0,
    pitch: 0,
    radius: 0,
    labelWidth: 0,
    groupGap: 0,
    labelLine: 0,
    labels,
    formatHeld,
    family: "",
    palette: null as Palette | null,
    last: 0,
    raf: 0,
    visible: true,
    hover: -1,
    nextIdle: 0,
    position: 0,
    invalidate: () => {},
    measure: () => {},
  });
  live.current.hover = tip?.cell ?? -1;
  live.current.labels = labels;
  live.current.formatHeld = formatHeld;

  // A new crowd: keep what is on screen, bring in the rest.
  useEffect(() => {
    const state = live.current;
    state.layout = layout;
    state.measure();
    state.anim = makeAnim(layout.cells.length, state.anim, performance.now(), !reduced);
    state.position = position;
    if (timeline) {
      state.anim.held = holdingsAt(timeline, position);
      state.anim.target = Float32Array.from(state.anim.held, (tokens) => levelOf(tokens, timeline.max));
      if (reduced) state.anim.level.set(state.anim.target);
    }
    state.invalidate();
    // The effect below follows the replay; this one only starts a crowd.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, timeline, reduced]);

  // With no run behind it, a share of the dots holds something.
  useEffect(() => {
    if (timeline || !live.current.anim) return;
    const anim = live.current.anim;
    for (let i = 0; i < anim.target.length; i++) {
      anim.target[i] = seeded(i, 1) < fill ? 0.25 + 0.75 * seeded(i, 2) : 0;
    }
    if (reduced) anim.level.set(anim.target);
    live.current.invalidate();
  }, [fill, timeline, layout, reduced]);

  // Follow the replay: small steps forward play their events, anything else just moves the levels.
  useEffect(() => {
    const state = live.current;
    const anim = state.anim;
    if (!timeline || !anim || anim.level.length !== layout.cells.length) return;
    const previous = state.position;
    if (position === previous) return;
    if (position > previous && position - previous <= 64) {
      for (let step = previous + 1; step <= position; step++) {
        const event = timeline.events[step];
        if (!event) continue;
        const { cell, kind, tokens } = event;
        if (tokens !== 0) {
          anim.held[cell] = Math.max(0, anim.held[cell]! + tokens);
          anim.target[cell] = levelOf(anim.held[cell]!, timeline.max);
        }
        if (reduced) continue;
        if (kind === "buy") {
          anim.buy[cell] = 1;
          anim.popV[cell] = 1.6;
        } else if (kind === "sell") {
          anim.sell[cell] = 1;
          anim.popV[cell] = -1.2;
        } else if (kind === "reverted") {
          anim.sell[cell] = 0.35;
        } else if (kind === "post") {
          anim.ring[cell] = 0;
        }
      }
    } else {
      anim.held = holdingsAt(timeline, position);
      anim.target = Float32Array.from(anim.held, (tokens) => levelOf(tokens, timeline.max));
      if (reduced) anim.level.set(anim.target);
    }
    state.position = position;
    state.invalidate();
  }, [position, timeline, layout, reduced]);

  // Size, theme and the frame loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const state = live.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const measure = () => {
      const width = box.getBoundingClientRect().width;
      if (width === 0) return;
      const { columns, rows, groups } = state.layout;
      // On a narrow screen each persona's name sits above its dots instead of beside them.
      const beside = state.labels && width >= 420;
      // Long enough for the longest name and its count, however many kinds of trader the crowd has.
      ctx.font = `450 12px ${state.family}`;
      const widest = Math.max(0, ...groups.map((group) => ctx.measureText(`${personaLabel(group.persona, group.count)}  ${group.count}`).width));
      state.labelWidth = beside ? Math.max(LABEL_WIDTH, Math.ceil(widest) + LABEL_MARGIN) : 0;
      state.labelLine = state.labels && !beside ? LABEL_LINE : 0;
      const held = beside && state.formatHeld ? HELD_WIDTH : 0;
      state.pitch = Math.min(maxPitch, (width - state.labelWidth - held) / Math.max(1, columns));
      state.radius = state.pitch * 0.4;
      state.groupGap = Math.max(5, state.pitch * 0.4);
      const height = Math.ceil(rows * state.pitch + (groups.length - 1) * state.groupGap + groups.length * state.labelLine);
      state.width = width;
      state.height = height;
      box.style.height = `${height}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };
    state.measure = measure;

    const positionOf = (i: number) => {
      const cell = state.layout.cells[i]!;
      const group = state.layout.groups.findIndex((g) => g.persona === cell.persona);
      return {
        x: state.labelWidth + (cell.col + 0.5) * state.pitch,
        y: (cell.row + 0.5) * state.pitch + group * state.groupGap + (group + 1) * state.labelLine,
      };
    };

    const applyTheme = () => {
      state.palette = readPalette();
      state.family = getComputedStyle(box).fontFamily;
      measure();
      state.invalidate();
    };

    const draw = (now: number) => {
      const { anim, palette, radius, width, height } = state;
      if (!anim || !palette || radius === 0) return false;
      const { cells, groups } = state.layout;
      if (anim.level.length !== cells.length) return false;
      const dt = Math.max(0, Math.min(0.05, (now - state.last) / 1000));
      state.last = now;
      let active = false;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // The names of the rows, and what each kind of trader holds.
      if (state.labels) {
        ctx.textBaseline = "middle";
        ctx.font = `450 12px ${state.family}`;
        groups.forEach((group, g) => {
          const y = group.firstRow * state.pitch + g * state.groupGap + g * state.labelLine;
          const middle = state.labelLine ? y + state.labelLine / 2 - 2 : y + state.pitch / 2;
          const name = personaLabel(group.persona, group.count);
          ctx.fillStyle = palette.ink;
          ctx.fillText(name, 0, middle);
          const used = ctx.measureText(`${name}  `).width;
          ctx.fillStyle = palette.ink3;
          ctx.fillText(String(group.count), used, middle);
          if (state.formatHeld) {
            let total = 0;
            for (let i = 0; i < cells.length; i++) if (cells[i]!.persona === group.persona) total += anim.held[i]!;
            ctx.fillStyle = palette.ink;
            ctx.textAlign = "right";
            ctx.fillText(state.formatHeld(total), width, middle);
            ctx.textAlign = "left";
          }
        });
      }

      ctx.lineWidth = 1;
      const small = radius < SMALL_DOT;
      for (let i = 0; i < cells.length; i++) {
        const age = now - anim.born[i]!;
        if (age < 0) {
          active = true;
          continue;
        }
        const appear = age >= APPEAR_MS ? 1 : 1 - (1 - age / APPEAR_MS) ** 3;
        if (age < APPEAR_MS) active = true;

        const level = anim.level[i]! + (anim.target[i]! - anim.level[i]!) * Math.min(1, dt * 6);
        anim.level[i] = level;
        if (Math.abs(anim.target[i]! - level) > 0.003) active = true;
        anim.popV[i] = anim.popV[i]! + (-170 * anim.pop[i]! - 17 * anim.popV[i]!) * dt;
        anim.pop[i] = anim.pop[i]! + anim.popV[i]! * dt;
        if (Math.abs(anim.pop[i]!) > 0.002 || Math.abs(anim.popV[i]!) > 0.02) active = true;
        const buy = (anim.buy[i] = anim.buy[i]! * Math.exp(-dt * 2.6));
        const sell = (anim.sell[i] = anim.sell[i]! * Math.exp(-dt * 2.6));
        if (buy + sell > 0.012) active = true;

        const { x, y } = positionOf(i);
        const r = radius * appear * (1 + anim.pop[i]!);
        ctx.globalAlpha = appear;

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = palette.dot;
        ctx.fill();

        if (level > 0.005 && small) {
          ctx.globalAlpha = appear * level;
          ctx.fillStyle = palette.held;
          ctx.fill();
          ctx.globalAlpha = appear;
        } else if (level > 0.005) {
          ctx.save();
          ctx.clip();
          ctx.fillStyle = palette.held;
          ctx.fillRect(x - r - 1, y + r - 2 * r * level, 2 * r + 2, 2 * r * level + 1);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }

        if (buy > 0.012 || sell > 0.012) {
          ctx.globalAlpha = appear * Math.max(buy, sell) * 0.95;
          ctx.fillStyle = buy >= sell ? palette.buy : palette.sell;
          ctx.fill();
          ctx.globalAlpha = appear;
        }

        if (!small || state.hover === i) {
          ctx.strokeStyle = state.hover === i ? palette.ink : palette.line;
          ctx.stroke();
        }

        if (anim.ring[i]! < 1) {
          const ring = (anim.ring[i] = Math.min(1, anim.ring[i]! + dt * 1.25));
          active = true;
          ctx.beginPath();
          ctx.arc(x, y, r * (1 + ring * 0.85), 0, Math.PI * 2);
          ctx.globalAlpha = (1 - ring) * 0.85;
          ctx.strokeStyle = palette.post;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      return active;
    };

    // With no run behind it, the chart still looks alive: a dot acts now and then.
    const idle = (now: number) => {
      const { anim } = state;
      if (timeline || reduced || !anim || now < state.nextIdle) return;
      state.nextIdle = now + 500 + Math.random() * 900;
      const cell = Math.floor(Math.random() * anim.level.length);
      const roll = Math.random();
      if (roll < 0.4) {
        anim.buy[cell] = 0.9;
        anim.popV[cell] = 1.4;
        anim.target[cell] = Math.min(1, anim.target[cell]! + 0.25);
      } else if (roll < 0.65) {
        anim.sell[cell] = 0.9;
        anim.popV[cell] = -1;
        anim.target[cell] = Math.max(0, anim.target[cell]! - 0.35);
      } else {
        anim.ring[cell] = 0;
      }
    };

    const frame = (now: number) => {
      state.raf = 0;
      if (!state.visible) return;
      idle(now);
      const active = draw(now);
      if (active || (!timeline && !reduced)) state.raf = requestAnimationFrame(frame);
    };

    state.invalidate = () => {
      if (!state.raf && state.visible) {
        state.last = performance.now();
        state.raf = requestAnimationFrame(frame);
      }
    };

    applyTheme();
    void document.fonts?.ready.then(() => state.invalidate());
    const sized = new ResizeObserver(() => {
      if (Math.abs(box.getBoundingClientRect().width - state.width) > 0.5) {
        measure();
        state.invalidate();
      }
    });
    sized.observe(box);
    const seen = new IntersectionObserver(([entry]) => {
      state.visible = entry!.isIntersecting;
      if (state.visible) state.invalidate();
    });
    seen.observe(box);
    const themed = new MutationObserver(applyTheme);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
      state.invalidate = () => {};
      state.measure = () => {};
      sized.disconnect();
      seen.disconnect();
      themed.disconnect();
    };
  }, [maxPitch, reduced, timeline]);

  const onPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tipFor) return;
    const state = live.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best = -1;
    let bestDistance = state.pitch * 0.62;
    layout.cells.forEach((cell, i) => {
      const group = layout.groups.findIndex((g) => g.persona === cell.persona);
      const x = state.labelWidth + (cell.col + 0.5) * state.pitch;
      const y = (cell.row + 0.5) * state.pitch + group * state.groupGap + (group + 1) * state.labelLine;
      const distance = Math.hypot(x - px, y - py);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    if (best < 0) {
      setTip(null);
    } else {
      const cell = layout.cells[best]!;
      const group = layout.groups.findIndex((g) => g.persona === cell.persona);
      setTip({
        cell: best,
        left: Math.max(0, Math.min(state.width - 190, state.labelWidth + cell.col * state.pitch - 80)),
        top: (cell.row + 1) * state.pitch + group * state.groupGap + (group + 1) * state.labelLine + 6,
      });
    }
    state.invalidate();
  };

  return (
    <div ref={boxRef} className={styles.crowd}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onPointer}
        onPointerLeave={() => {
          setTip(null);
          live.current.invalidate();
        }}
      />
      {tip && tipFor && live.current.anim && (
        <div className={styles.tip} style={{ left: tip.left, top: tip.top }}>
          {tipFor(tip.cell, live.current.anim.held[tip.cell] ?? 0)}
        </div>
      )}
    </div>
  );
}
