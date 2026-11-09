import type { CalibrationEntry, CalibrationResponse, OpenQuestion } from "@hyvo/schema";
import { Link } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { CountUp } from "../components/motion-data/CountUp";
import { Reveal, useInView } from "../components/Reveal";
import { Failure, Loading } from "../components/States";
import { fetchCalibration } from "../lib/api";
import { txUrl } from "../lib/explorer";
import { formatDate, shortHash } from "../lib/format";
import { useAsync } from "../lib/use-async";
import { useTitle } from "../lib/use-title";
import styles from "./CalibrationPage.module.css";

const RESULT_LABEL: Record<CalibrationEntry["result"], string> = {
  hit: "Hit",
  miss: "Miss",
  no_lean: "No lean",
  void: "Void",
};

const LEAN: Record<CalibrationEntry["expectation"], string> = { yes: "leaned yes", no: "leaned no", split: "was split" };

function Votes({ yes, no, unsure }: { yes: number; no: number; unsure: number }) {
  const total = Math.max(1, yes + no + unsure);
  const share = (count: number) => `${(count / total) * 100}%`;
  // The bar grows from nothing the first time it is seen.
  const [ref, seen] = useInView<HTMLSpanElement>(0.3);
  return (
    <span className={styles.votes}>
      <span ref={ref} className={styles.bar} data-in={seen} aria-hidden="true">
        <i className={styles.yes} style={{ width: share(yes) }} />
        <i className={styles.no} style={{ width: share(no) }} />
      </span>
      <span className="num">
        {yes} yes · {no} no · {unsure} unsure
      </span>
    </span>
  );
}

/** How often the crowd's lean matched what happened (SPEC 11.2). Misses are shown exactly as loudly as hits. */
export function CalibrationPage() {
  useTitle("Calibration");
  const state = useAsync(fetchCalibration, "calibration");
  if (state.status === "loading") return <Loading label="Loading the record…" page />;
  if (state.status === "error") return <Failure message={state.error.message} onRetry={state.reload} />;
  return <Record data={state.data} />;
}

function Record({ data }: { data: CalibrationResponse }) {
  const { counts, hitRate, buckets, resolved, open } = data;
  const decided = counts.hits + counts.misses;
  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Calibration</h1>
        <p>
          A run can carry a yes or no question. At the end of the run each agent answers, and the crowd's lean is hashed with the run, on-chain, before the
          outcome is known. After the date, the outcome goes on-chain too. This page counts how often the two matched, misses as plainly as hits.
        </p>
      </header>

      <section className={styles.tally} aria-label="The record so far">
        <div>
          <b className="num">
            <CountUp value={counts.hits} format={String} />
          </b>
          <span>Hits</span>
        </div>
        <div>
          <b className="num">
            <CountUp value={counts.misses} format={String} />
          </b>
          <span>Misses</span>
        </div>
        <div>
          <b className="num">{hitRate === null ? "n/a" : <CountUp value={Math.round(hitRate * 100)} format={(n) => `${n}%`} />}</b>
          <span>{decided === 0 ? "Nothing to rate yet" : `Hit rate, of ${decided}`}</span>
        </div>
        <div>
          <b className="num">
            <CountUp value={counts.open} format={String} />
          </b>
          <span>Still open</span>
        </div>
      </section>
      {(counts.noLean > 0 || counts.void > 0) && (
        <p className={styles.small}>
          Left out of the rate: {counts.noLean} where the crowd was split, {counts.void} declared void.
        </p>
      )}

      {decided > 0 && (
        <section className={styles.section} aria-labelledby="by-firmness">
          <h2 id="by-firmness">By how firm the lean was</h2>
          <p className={styles.small}>The larger side's share of the yes and no answers. A firm lean that often misses is worth less than it looks.</p>
          <Reveal as="ul" className={styles.buckets}>
            {buckets.map((bucket, index) => {
              const total = bucket.hits + bucket.misses;
              return (
                <li key={bucket.label} style={{ "--i": index } as React.CSSProperties}>
                  <span className="num">{bucket.label}</span>
                  <span className={styles.bucketBar} aria-hidden="true">
                    <i className={styles.hitFill} style={{ width: total ? `${(bucket.hits / total) * 100}%` : 0 }} />
                    <i className={styles.missFill} style={{ width: total ? `${(bucket.misses / total) * 100}%` : 0 }} />
                  </span>
                  <span className="num">{total === 0 ? "none" : `${bucket.hits} hit, ${bucket.misses} missed`}</span>
                </li>
              );
            })}
          </Reveal>
        </section>
      )}

      <section className={styles.section} aria-labelledby="resolved">
        <h2 id="resolved">Resolved</h2>
        {resolved.length === 0 ? (
          <p className={styles.empty}>No question has been resolved yet. The first one appears here when its date has passed and its outcome is on-chain.</p>
        ) : (
          <ul className={styles.entries}>
            {resolved.map((entry) => (
              <Resolved key={entry.runId} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      {open.length > 0 && (
        <section className={styles.section} aria-labelledby="open">
          <h2 id="open">Open</h2>
          <ul className={styles.entries}>
            {open.map((entry) => (
              <Open key={entry.runId} entry={entry} />
            ))}
          </ul>
        </section>
      )}
      <Disclaimer />
    </article>
  );
}

function Resolved({ entry }: { entry: CalibrationEntry }) {
  return (
    <li className={styles.entry}>
      <p className={styles.result}>
        <span className={`${styles.tag} ${entry.result === "hit" ? styles.tagHit : entry.result === "miss" ? styles.tagMiss : styles.tagNeutral}`}>{RESULT_LABEL[entry.result]}</span>
        <span className={styles.small}>
          The crowd {LEAN[entry.expectation]}. The outcome was {entry.outcome}.
        </span>
      </p>
      <h3>{entry.question}</h3>
      <Votes yes={entry.yes} no={entry.no} unsure={entry.unsure} />
      <p className={styles.note}>{entry.note}</p>
      <p className={styles.small}>
        <Link to={`/run/${entry.runId}`} viewTransition>
          {entry.title}
        </Link>{" "}
        · decided {formatDate(entry.decidedAt)}
        {entry.evidenceUrl && (
          <>
            {" "}
            ·{" "}
            <a href={entry.evidenceUrl} target="_blank" rel="noreferrer nofollow">
              evidence
            </a>
          </>
        )}
        {" · "}
        {entry.txHash ? (
          <a href={txUrl(entry.txHash)} target="_blank" rel="noreferrer" className="mono">
            {shortHash(entry.txHash, 6, 4)}
          </a>
        ) : (
          "on its way on-chain"
        )}
      </p>
    </li>
  );
}

function Open({ entry }: { entry: OpenQuestion }) {
  return (
    <li className={styles.entry}>
      <p className={styles.result}>
        <span className={`${styles.tag} ${styles.tagNeutral}`}>{entry.overdue ? "Waiting for its outcome" : `Resolves ${formatDate(entry.resolvesAt)}`}</span>
        <span className={styles.small}>The crowd {LEAN[entry.expectation]}.</span>
      </p>
      <h3>{entry.question}</h3>
      <Votes yes={entry.yes} no={entry.no} unsure={entry.unsure} />
      <p className={styles.small}>
        <Link to={`/run/${entry.runId}`} viewTransition>
          {entry.title}
        </Link>
      </p>
    </li>
  );
}
