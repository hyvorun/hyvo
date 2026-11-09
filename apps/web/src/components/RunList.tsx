import type { RunSummary } from "@hyvo/schema";
import { useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { formatDate, formatPct, modelLabel } from "../lib/format";
import { Reveal } from "./Reveal";
import styles from "./RunList.module.css";
import { Sparkline } from "./Sparkline";

export function RunList({ runs }: { runs: RunSummary[] }) {
  // One highlight for the whole list, which slides to the row under the mouse.
  const [hover, setHover] = useState<{ top: number; height: number; on: boolean }>({ top: 0, height: 0, on: false });
  if (runs.length === 0) {
    return <p className={styles.empty}>No runs are published yet. Published runs appear here as soon as they are hashed.</p>;
  }
  const follow = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    const row = event.currentTarget;
    setHover({ top: row.offsetTop, height: row.offsetHeight, on: true });
  };
  return (
    <div className={styles.wrap} onPointerLeave={() => setHover((now) => ({ ...now, on: false }))}>
      <span
        className={styles.highlight}
        data-on={hover.on}
        aria-hidden="true"
        style={{ "--top": `${hover.top}px`, height: hover.height } as CSSProperties}
      />
      <ul className={styles.list}>
        {runs.map((run, i) => (
          <Reveal as="li" key={run.runId} index={i % 6} onPointerEnter={follow}>
            <Link to={`/run/${run.runId}`} className={styles.row} viewTransition>
              <span className={styles.title}>{run.title}</span>
              <span className={styles.meta}>
                {run.crowdSize.toLocaleString("en-US")} agents · {run.rounds} rounds · {modelLabel(run.models.agents)} · {formatDate(run.publishedAt)}
                {run.status === "partial" && <> · stopped early ({run.stopReason?.replace(/_/g, " ")})</>}
              </span>
              <span className={styles.spark}>
                <Sparkline values={run.sparkline} />
              </span>
              <span className={`${styles.change} num ${run.market.priceChangePct >= 0 ? styles.up : styles.down}`}>
                {formatPct(run.market.priceChangePct)}
              </span>
            </Link>
          </Reveal>
        ))}
      </ul>
    </div>
  );
}
