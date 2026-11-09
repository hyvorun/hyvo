/**
 * The launches of the window as a map: one system per pair asset (the idea of Pons Atlas), drawn
 * with Hyvo's rules. A core is sized by how many launches chose that asset; each launch sits around
 * it, closer the further its curve is towards graduation; a framed square has graduated. Nothing is
 * colored by direction or rated. Keyboard and screen reader users pick a system from its core and
 * read its launches in the list under the map.
 */
import { distinctName, formatAmount, layoutAtlas, shortAddress, type AtlasSystem, type Launch } from "@hyvo/launches";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { pairLabel, Towards } from "./parts";
import styles from "./Launches.module.css";

const NODE = 7;

export function Atlas({ launches }: { launches: readonly Launch[] }) {
  const box = useRef<HTMLDivElement>(null);
  // The drawing is laid out in pixels of its own width, so labels keep their size on a phone.
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columns = width >= 620 ? 3 : 2;
  const cell = Math.max(150, Math.floor(width / columns));
  const layout = useMemo(() => layoutAtlas(launches, { columns, cell, maxSystems: columns * 3, maxNodes: 18 }), [launches, columns, cell]);
  const [selected, setSelected] = useState<string | null>(null);
  const current = layout.systems.find((system) => system.key === selected) ?? layout.systems[0] ?? null;
  const navigate = useNavigate();

  if (layout.systems.length === 0) return <p className={styles.note}>No launch to place in this window.</p>;

  const pick = (system: AtlasSystem) => setSelected(system.key);
  const onKey = (event: KeyboardEvent, system: AtlasSystem) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(system);
    }
  };
  const labelSpace = 34;

  return (
    <div className={styles.atlas} ref={box}>
      <svg
        className={styles.map}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={`Launches by pair asset: ${layout.systems.map((system) => `${pairLabel(system.pair)} ${system.launches}`).join(", ")}`}
      >
        {layout.systems.map((system) => {
          const cx = system.x + layout.cell / 2;
          const cy = system.y + (layout.cell - labelSpace) / 2 + 4;
          const active = current?.key === system.key;
          const outer = layout.cell * 0.36;
          return (
            <g key={system.key} className={styles.system} data-active={active}>
              <circle cx={cx} cy={cy} r={outer} className={styles.orbit} aria-hidden="true" />
              <circle cx={cx} cy={cy} r={system.radius + layout.cell * 0.06} className={styles.inner} aria-hidden="true" />
              {system.nodes.map((node) => {
                const x = cx + node.x - NODE / 2;
                const y = cy + node.y - NODE / 2;
                const graduated = node.launch.graduated === true;
                const unknown = node.progress === null && !graduated;
                return (
                  <g
                    key={node.launch.token}
                    className={styles.node}
                    data-kind={graduated ? "graduated" : unknown ? "unknown" : "curve"}
                    aria-hidden="true"
                    onClick={() => navigate(`/launches/${node.launch.token}`, { viewTransition: true })}
                  >
                    <title>{`${node.launch.symbol ?? shortAddress(node.launch.token)}: ${graduated ? "graduated" : node.progress === null ? "curve not read" : `${Math.round(node.progress * 1000) / 10}% towards graduation`}`}</title>
                    {/* A wider target than the mark, for fingers. */}
                    <rect x={x - 5} y={y - 5} width={NODE + 10} height={NODE + 10} className={styles.hit} />
                    <rect x={x} y={y} width={NODE} height={NODE} />
                    {graduated && <rect x={x - 2.5} y={y - 2.5} width={NODE + 5} height={NODE + 5} className={styles.frame} />}
                  </g>
                );
              })}
              <g
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={`${pairLabel(system.pair)}: ${system.launches} ${system.launches === 1 ? "launch" : "launches"}, ${system.graduated} graduated. Show them below the map.`}
                className={styles.core}
                onClick={() => pick(system)}
                onKeyDown={(event) => onKey(event, system)}
              >
                <circle cx={cx} cy={cy} r={system.radius} />
                <text x={cx} y={cy} dominantBaseline="central" textAnchor="middle" className={styles.coreLabel} style={{ fontSize: Math.max(11, Math.min(18, system.radius * 0.62)) }}>
                  {pairLabel(system.pair).slice(0, 6)}
                </text>
              </g>
              <text x={cx} y={system.y + layout.cell - 14} textAnchor="middle" className={styles.systemLabel} aria-hidden="true">
                {system.launches} {system.launches === 1 ? "launch" : "launches"}
                {system.hidden > 0 ? ` · ${system.hidden} not drawn` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className={styles.legend} aria-label="How to read the map">
        <li>
          <i className={styles.legendCore} aria-hidden="true" /> A pair asset, sized by its launches
        </li>
        <li>
          <i className={styles.legendCurve} aria-hidden="true" /> On its curve: closer is further towards graduation
        </li>
        <li>
          <i className={styles.legendGraduated} aria-hidden="true" /> Graduated
        </li>
        {layout.otherPairs > 0 && (
          <li>
            {layout.otherLaunches} more {layout.otherLaunches === 1 ? "launch pairs" : "launches pair"} with {layout.otherPairs} other {layout.otherPairs === 1 ? "asset" : "assets"}
          </li>
        )}
      </ul>
      {current && <SystemList system={current} />}
    </div>
  );
}

function SystemList({ system }: { system: AtlasSystem }) {
  const shown = system.nodes.slice(0, 8);
  return (
    <div className={styles.systemList} aria-live="polite">
      <h3>
        Paired with {pairLabel(system.pair)}
        {system.pair.name && system.pair.name !== system.pair.symbol ? <span>{system.pair.name}</span> : null}
      </h3>
      <p className={styles.fine}>
        {system.launches} {system.launches === 1 ? "launch" : "launches"}, {system.graduated} graduated, {formatAmount(system.liquidity, system.pair.decimals)} {pairLabel(system.pair)} on their curves. Furthest
        towards graduation first:
      </p>
      <ol>
        {shown.map((node) => (
          <li key={node.launch.token}>
            <Link to={`/launches/${node.launch.token}`} viewTransition>
              <b>{node.launch.symbol ?? shortAddress(node.launch.token)}</b>
              <span>{distinctName(node.launch.name, node.launch.symbol) ?? ""}</span>
            </Link>
            <Towards liquidity={node.launch.liquidity} threshold={node.launch.graduationThreshold} graduated={node.launch.graduated} />
          </li>
        ))}
      </ol>
    </div>
  );
}
