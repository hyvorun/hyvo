import type { RunSummary } from "@hyvo/schema";
import { Link } from "react-router";
import { formatDate, formatPct, modelLabel } from "../lib/format";
import { Reveal } from "./Reveal";
import styles from "./RunList.module.css";
import { Sparkline } from "./Sparkline";

export function RunList({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return <p className={styles.empty}>No runs are published yet. Published runs appear here as soon as they are hashed.</p>;
  }
  return (
    <ul className={styles.list}>
      {runs.map((run, i) => (
        <Reveal as="li" key={run.runId} index={i % 6}>
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
  );
}
