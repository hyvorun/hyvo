import type { RunResponse, RunSummary } from "@hyvo/schema";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { HashBadge } from "../components/HashBadge";
import { Arrow } from "../components/Icons";
import { JobStatus } from "../components/JobStatus";
import { OracleBadge } from "../components/OracleBadge";
import { Replay } from "../components/Replay";
import { ReportPanel } from "../components/ReportPanel";
import { CountUp } from "../components/motion-data/CountUp";
import { ClonePanel } from "../components/ClonePanel";
import { RewindPanel } from "../components/RewindPanel";
import { RunProvenance } from "../components/RunProvenance";
import { Failure, Loading } from "../components/States";
import { ApiError, fetchRunDocument, fetchRunStatus } from "../lib/api";
import { blockUrl } from "../lib/explorer";
import { formatDate, formatPct, modelLabel } from "../lib/format";
import { isSwap } from "../lib/replay";
import { useAsync } from "../lib/use-async";
import { useTitle } from "../lib/use-title";
import styles from "./pages.module.css";

const QUEUE_POLL_MS = 4000;
const COMMIT_POLL_MS = 10_000;
const MAX_COMMIT_POLLS = 30;

type StatusState = { status: "loading" } | { status: "ready"; data: RunResponse } | { status: "error"; error: Error };

/** The run's status, polled while it is queued or running, and while its oracle commit is on its way. */
function useRunStatus(runId: string): StatusState & { reload: () => void } {
  const [state, setState] = useState<StatusState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let commitPolls = 0;
    let loaded = false;
    const tick = async () => {
      try {
        const data = await fetchRunStatus(runId);
        if (!alive) return;
        loaded = true;
        setState({ status: "ready", data });
        const waiting = !data.run && data.job !== null && data.job.status !== "failed";
        const committing = data.run !== null && data.oracle !== null && data.oracle.status !== "confirmed";
        if (waiting) timer = window.setTimeout(tick, QUEUE_POLL_MS);
        else if (committing && commitPolls++ < MAX_COMMIT_POLLS) timer = window.setTimeout(tick, COMMIT_POLL_MS);
      } catch (error) {
        if (!alive) return;
        // A failed poll of a run on screen is not worth an error page: ask again.
        if (loaded) timer = window.setTimeout(tick, QUEUE_POLL_MS);
        else setState({ status: "error", error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    setState({ status: "loading" });
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [runId, attempt]);

  return { ...state, reload: () => setAttempt((n) => n + 1) };
}

export function RunPage() {
  const { runId = "" } = useParams();
  const state = useRunStatus(runId);

  if (state.status === "loading") return <Loading label="Loading the run…" />;
  if (state.status === "error") {
    const missing = state.error instanceof ApiError && state.error.status === 404;
    return (
      <div className={styles.narrow}>
        <Failure
          message={missing ? "No run has this id. Check the link, or browse the published runs." : state.error.message}
          onRetry={missing ? undefined : state.reload}
        />
        <Link to="/runs" className="arrow-link" viewTransition>
          Browse runs <Arrow />
        </Link>
      </div>
    );
  }
  const { run, job, oracle, outcome } = state.data;
  if (!run) return job ? <JobStatus runId={runId} job={job} /> : <Loading label="Loading the run…" />;
  return <PublishedRun runId={runId} oracle={oracle} summary={run} outcome={outcome ?? null} />;
}

const LEAN = { yes: "leaned yes", no: "leaned no", split: "was split" } as const;

/** The run's question: what the crowd expected, committed before the date, and what happened. */
function CrowdAnswer({ question, outcome }: { question: NonNullable<RunSummary["question"]>; outcome: NonNullable<RunResponse["outcome"]> | null }) {
  return (
    <section className={styles.question} aria-label="The crowd's answer">
      <h2>{question.text}</h2>
      <p>
        The synthetic crowd {LEAN[question.expectation]}: {question.yes} yes, {question.no} no, {question.unsure} unsure.
      </p>
      {outcome ? (
        <p>
          The outcome was {outcome.outcome}. {outcome.note}
        </p>
      ) : (
        <p>Its outcome can be recorded after {formatDate(question.resolvesAt)}.</p>
      )}
      <Link to="/calibration" viewTransition>
        Calibration
      </Link>
    </section>
  );
}

function PublishedRun({
  runId,
  oracle,
  summary,
  outcome,
}: {
  runId: string;
  oracle: RunResponse["oracle"];
  summary: RunSummary;
  outcome: NonNullable<RunResponse["outcome"]> | null;
}) {
  const state = useAsync(() => fetchRunDocument(runId), runId);
  useTitle(state.status === "ready" ? state.data.scenario.title : null);

  if (state.status === "loading") return <Loading label="Loading the run…" />;
  if (state.status === "error") {
    return (
      <div className={styles.narrow}>
        <Failure message={state.error.message} onRetry={state.reload} />
        <Link to="/runs" className="arrow-link" viewTransition>
          Browse runs <Arrow />
        </Link>
      </div>
    );
  }

  const run = state.data;
  const models = run.crowd.model;
  const actions = run.rounds.flatMap((round) => round.actions).filter((action) => isSwap(action) && action.status === "ok");
  const buys = actions.filter((action) => action.kind === "swap_buy").length;
  const posts = run.rounds.flatMap((round) => round.posts);
  const start = Number(run.world.initialMarket.price);
  const end = Number(run.rounds.at(-1)?.market.price ?? start);
  const change = ((end - start) / start) * 100;
  const whole = (value: number) => Math.round(value).toLocaleString("en-US");
  return (
    <article className={styles.run}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/runs" viewTransition>
          Runs
        </Link>
        <span aria-hidden="true">/</span>
        <span className="mono">{run.runId}</span>
      </nav>

      <header className={styles.runHead}>
        <div className={styles.runTitle}>
          <h1>{run.scenario.title}</h1>
          <p className={styles.meta}>
            {run.crowd.size.toLocaleString("en-US")} synthetic agents · {run.rounds.length} rounds · agents: {modelLabel(models.agents)} · report:{" "}
            {modelLabel(models.report)} · {formatDate(run.createdAt)}
            {run.status === "partial" && <> · stopped early ({run.stopReason?.replace(/_/g, " ")})</>}
          </p>
          <p className={styles.meta}>
            {run.world.forkBlock === null ? (
              "Played on a plain local test chain, not on a fork."
            ) : (
              <>
                Played on a private fork of Robinhood Chain from{" "}
                <a href={blockUrl(run.world.forkBlock)} target="_blank" rel="noreferrer">
                  block <span className="num">{run.world.forkBlock.toLocaleString("en-US")}</span>
                </a>
                . Its trades stay on that fork, so they are not on the public chain.
              </>
            )}
          </p>
        </div>
        <div className={styles.proof}>
          <HashBadge run={run} />
          <OracleBadge runId={run.runId} oracle={oracle} />
          <Disclaimer />
        </div>
        {run.scenario.seedText && (
          <details className={styles.scenario}>
            <summary>Read the scenario</summary>
            <p>{run.scenario.seedText}</p>
            {run.scenario.injectedEvents.length > 0 && (
              <ul>
                {run.scenario.injectedEvents.map((event) => (
                  <li key={`${event.round}-${event.text}`}>
                    <span className="num">R{event.round}</span> {event.text}
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
        <RunProvenance run={run} />
      </header>

      {summary.question && <CrowdAnswer question={summary.question} outcome={outcome} />}

      <Replay run={run} />

      {run.rewind && <RewindPanel run={run} />}
      <ClonePanel run={run} />

      <ul className={styles.stats} aria-label="The run in numbers">
        <li>
          <span className={styles.statLabel}>Price over the run</span>
          <b className={`num ${change >= 0 ? styles.up : styles.down}`}>
            <CountUp value={change} format={formatPct} />
          </b>
        </li>
        <li>
          <span className={styles.statLabel}>Bought / sold</span>
          <b className="num">
            <CountUp value={buys} format={whole} /> / <CountUp value={actions.length - buys} format={whole} />
          </b>
        </li>
        <li>
          <span className={styles.statLabel}>Posts in the feed</span>
          <b className="num">
            <CountUp value={posts.length} format={whole} />
          </b>
        </li>
        <li>
          <span className={styles.statLabel}>Likes</span>
          <b className="num">
            <CountUp value={posts.reduce((sum, post) => sum + post.likes, 0)} format={whole} />
          </b>
        </li>
      </ul>

      <ReportPanel run={run} />
    </article>
  );
}
