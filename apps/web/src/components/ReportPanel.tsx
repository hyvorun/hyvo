import type { RunV1 } from "@hyvo/schema";
import type { CSSProperties } from "react";
import { Disclaimer } from "./Disclaimer";
import styles from "./ReportPanel.module.css";
import { Reveal, useInView } from "./Reveal";

interface Props {
  run: RunV1;
}

/** The report agent's read of the run: summary, turning point, mood by round, objections and
 * what moved the price. Numbers come from code; the prose cites the run's own posts. */
export function ReportPanel({ run }: Props) {
  const { report } = run;
  return (
    <section className={styles.report} aria-labelledby="report-title">
      <Reveal className={styles.lead}>
        <h2 id="report-title">What the crowd did</h2>
        <p className={styles.summary}>{report.summary}</p>
        <Disclaimer />
      </Reveal>

      <div className={styles.grid}>
        {report.turningPoint && (
          <Reveal index={0} className={styles.block}>
            <h3>
              Turning point <span className={`${styles.at} num`}>round {report.turningPoint.round}</span>
            </h3>
            <p>
              <Cited text={report.turningPoint.why} />
            </p>
          </Reveal>
        )}

        <Reveal index={1} className={styles.block}>
          <h3>Crowd mood by round</h3>
          <Mood values={report.sentimentByRound} />
          <p className={styles.note}>Mean of the moods the agents reported, from −1 to 1.</p>
        </Reveal>

        {report.objections.length > 0 && (
          <Reveal index={2} className={styles.block}>
            <h3>Objections in the feed</h3>
            <ul>
              {report.objections.map((text) => (
                <li key={text}>
                  <Cited text={text} />
                </li>
              ))}
            </ul>
          </Reveal>
        )}

        {report.priceDrivers.length > 0 && (
          <Reveal index={3} className={styles.block}>
            <h3>What moved the price</h3>
            <ul>
              {report.priceDrivers.map((text) => (
                <li key={text}>
                  <Cited text={text} />
                </li>
              ))}
            </ul>
          </Reveal>
        )}
      </div>
    </section>
  );
}

/** Prose whose citations of posts, like (p3, p9), step back so that the sentence reads first. */
function Cited({ text }: { text: string }) {
  return text.split(/(\([a-z]\d+(?:, ?[a-z]\d+)*\))/).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className={`${styles.cite} num`} title="Post ids in this run's run.json">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function Mood({ values }: { values: number[] }) {
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const max = Math.max(0.05, ...values.map(Math.abs));
  return (
    <div ref={ref} className={styles.mood} data-in={seen} role="img" aria-label={`Mean agent sentiment per round: ${values.join(", ")}`}>
      {values.map((value, i) => (
        <div key={i} className={styles.moodRound} title={`Round ${i + 1}: ${value.toFixed(2)}`} style={{ "--i": i } as CSSProperties}>
          <div className={styles.moodUp}>
            <span style={{ height: `${(Math.max(value, 0) / max) * 100}%` }} />
          </div>
          <div className={styles.moodDown}>
            <span style={{ height: `${(Math.max(-value, 0) / max) * 100}%` }} />
          </div>
          <span className={`${styles.moodLabel} num`}>{i + 1}</span>
        </div>
      ))}
    </div>
  );
}
