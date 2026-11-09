import type { JobView } from "@hyvo/schema";
import { useMemo } from "react";
import { Link } from "react-router";
import { previewLayout } from "../lib/crowd";
import { Crowd } from "./Crowd";
import { Arrow, CheckMark } from "./Icons";
import styles from "./JobStatus.module.css";

/**
 * Where what a failed run cost went, which depends on how it was paid (`JobView.refund`): from a prepaid balance it is
 * already back there; paid on-chain it is refunded to the paying wallet; a holder's free run goes back to this month's.
 */
export function failedRunMoney(refund: JobView["refund"]): string {
  switch (refund) {
    case "credited":
      return "Its price went straight back to the prepaid balance it was paid from.";
    case "sent":
      return "The payment was refunded to the wallet that paid.";
    case "due":
      return "The payment will be refunded to the wallet that paid it.";
    default:
      return "It was a free run, and it went back to the wallet's free runs for this month.";
  }
}

/** A run that is not published yet: where it is in the queue, and what happens next. The crowd fills as the rounds are
 * played. It may have been paid on-chain, from a prepaid balance or with a holder's free run, and the page says nothing
 * that holds for only one of them. */
export function JobStatus({ runId, job }: { runId: string; job: JobView }) {
  const rounds = job.progress?.rounds ?? null;
  const round = job.progress?.round ?? 0;
  const layout = useMemo(() => previewLayout(40), []);
  const fill = job.status === "failed" ? 0 : job.status === "complete" ? 1 : rounds ? Math.max(0.05, round / rounds) : 0.05;
  return (
    <section className={styles.panel} aria-live="polite">
      <div className={styles.copy}>
        <p className={styles.runId}>
          {(job.status === "queued" || job.status === "running") && <span className="live-dot" aria-hidden="true" />}
          <span>
            Run <span className="mono">{runId}</span>
          </span>
        </p>
        {job.status === "queued" && (
          <>
            <h1>Your run is in the queue</h1>
            <p>Nothing more is needed from you. A runner picks the run up next; this page updates on its own.</p>
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
                  <span key={i} className={i < round ? styles.done : i === round ? styles.now : undefined} />
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
              {job.attempt > 1 ? "It failed twice, so it will not start again." : "It failed in a way another attempt would not fix, so it will not start again."}{" "}
              {failedRunMoney(job.refund)}
            </p>
            <Link to="/new" className="arrow-link" viewTransition>
              Start a new run <Arrow />
            </Link>
          </>
        )}
        {job.status === "complete" && (
          <>
            <div className={styles.title}>
              <span className={`${styles.badge} pop`} aria-hidden="true">
                <CheckMark size={15} />
              </span>
              <h1>Published</h1>
            </div>
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
