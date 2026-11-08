import type { JobView } from "@hyvo/schema";
import { useMemo } from "react";
import { Link } from "react-router";
import { previewLayout } from "../lib/crowd";
import { Crowd } from "./Crowd";
import { Arrow } from "./Icons";
import styles from "./JobStatus.module.css";

/** A paid run that is not published yet: where it is in the queue, and what happens next. The crowd
 * fills as the rounds are played. */
export function JobStatus({ runId, job }: { runId: string; job: JobView }) {
  const rounds = job.progress?.rounds ?? null;
  const round = job.progress?.round ?? 0;
  const layout = useMemo(() => previewLayout(40), []);
  const fill = job.status === "failed" ? 0 : job.status === "complete" ? 1 : rounds ? Math.max(0.05, round / rounds) : 0.05;
  return (
    <section className={styles.panel} aria-live="polite">
      <div className={styles.copy}>
        <p className={styles.runId}>
          Run <span className="mono">{runId}</span>
        </p>
        {job.status === "queued" && (
          <>
            <h1>Your run is in the queue</h1>
            <p>The payment is confirmed. A runner picks the run up next; this page updates on its own.</p>
          </>
        )}
        {job.status === "running" && (
          <>
            <h1>The crowd is playing your scenario</h1>
            <p>
              {rounds ? `Round ${round} of ${rounds}.` : "Starting its world: a fresh fork, wallets and the pool."} The replay opens
              here when the run is published.
            </p>
            {rounds && (
              <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={rounds} aria-valuenow={round}>
                {Array.from({ length: rounds }, (_, i) => (
                  <span key={i} className={i < round ? styles.done : undefined} />
                ))}
              </div>
            )}
            {job.attempt > 1 && <p className={styles.note}>The first attempt did not finish, so the run started again.</p>}
          </>
        )}
        {job.status === "failed" && (
          <>
            <h1>This run could not be completed</h1>
            <p>
              It failed twice, so it will not start again.{" "}
              {job.refund === "sent"
                ? "The payment was refunded to the wallet that paid."
                : job.refund === "due"
                  ? "The payment will be refunded to the wallet that paid it."
                  : "Free runs are given back to the wallet's monthly allowance."}
            </p>
            <Link to="/new" className="arrow-link" viewTransition>
              Start a new run <Arrow />
            </Link>
          </>
        )}
        {job.status === "complete" && (
          <>
            <h1>Published</h1>
            <p>Loading the replay…</p>
          </>
        )}
      </div>
      <div className={`${styles.crowd} card`} aria-hidden="true">
        <Crowd layout={layout} fill={fill} maxPitch={20} ariaLabel="" />
      </div>
    </section>
  );
}
