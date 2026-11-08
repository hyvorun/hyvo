import type { RunV1 } from "@hyvo/schema";
import { addressUrl, blockUrl } from "../lib/explorer";
import { formatDate, formatPct } from "../lib/format";
import styles from "./RewindPanel.module.css";

const WIDTH = 640;
const HEIGHT = 180;
const PAD = 8;

function spanOf(hours: number): string {
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** Percent change from the first price, at each point. */
export function fromStart(prices: readonly string[]): number[] {
  const first = Number(prices[0]);
  return prices.map((price) => (first > 0 ? (Number(price) / first - 1) * 100 : 0));
}

/** The run next to what the real pool did, on one scale. It compares one run with one past, and says so. */
export function RewindPanel({ run }: { run: RunV1 }) {
  const rewind = run.rewind;
  if (!rewind) return null;
  const played = fromStart([run.world.initialMarket.price, ...run.rounds.map((round) => round.market.price)]);
  const actual = fromStart(rewind.actual.map((point) => point.price));
  const all = [...played, ...actual, 0];
  const low = Math.min(...all);
  const high = Math.max(...all);
  const span = high - low || 1;
  const steps = Math.max(1, rewind.actual.length - 1);
  const x = (index: number) => (index / steps) * WIDTH;
  const y = (value: number) => PAD + (1 - (value - low) / span) * (HEIGHT - 2 * PAD);
  const line = (values: readonly number[]) => values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  const lastPlayed = played.at(-1)!;
  const lastActual = actual.at(-1)!;

  return (
    <section className={styles.panel} aria-labelledby="rewind-title">
      <h2 id="rewind-title">Next to what actually happened</h2>
      <p>
        This run went back to{" "}
        <a href={blockUrl(rewind.block)} target="_blank" rel="noreferrer">
          block <span className="num">{rewind.block.toLocaleString("en-US")}</span>
        </a>{" "}
        of{" "}
        <a href={addressUrl(rewind.pool)} target="_blank" rel="noreferrer">
          a real pool
        </a>{" "}
        on {formatDate(rewind.at)}, and changed one thing: <em>{rewind.change}</em>
      </p>
      <figure className={styles.figure}>
        {/* Stretched to the panel's width, so the labels are text beside it rather than in it. */}
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`Price from the start: this run ${formatPct(lastPlayed)}, the real pool ${formatPct(lastActual)}, over ${spanOf(rewind.hours)}`}>
          <line className={styles.zero} x1={0} x2={WIDTH} y1={y(0)} y2={y(0)} />
          <path className={styles.actual} d={line(actual)} />
          <path className={styles.played} d={line(played)} />
        </svg>
        <div className={styles.axis}>
          <span>Start</span>
          <span>{spanOf(rewind.hours)} on</span>
        </div>
        <figcaption className={styles.legend}>
          <span>
            <i className={styles.keyPlayed} /> This run <b className="num">{formatPct(lastPlayed)}</b>
          </span>
          <span>
            <i className={styles.keyActual} /> The real pool <b className="num">{formatPct(lastActual)}</b>
          </span>
        </figcaption>
      </figure>
      <p className={styles.note}>The real pool's numbers come from the chain, and were fixed before this run started. This compares one run with one past. It is not a forecast of anything.</p>
    </section>
  );
}
