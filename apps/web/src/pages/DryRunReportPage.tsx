import { verifyRunHash, type DryRunReport, type DryRunView, type Finding } from "@hyvo/schema";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Failure, Loading } from "../components/States";
import { useWalletSession, Web3 } from "../components/Web3";
import { ApiError, fetchDryRun, fetchDryRunReport } from "../lib/api";
import { formatDate, personaLabel, shortHash } from "../lib/format";
import { useTitle } from "../lib/use-title";
import styles from "./DryRunPage.module.css";

const POLL_MS = 4000;

export function DryRunReportPage() {
  useTitle("Dry Run report");
  return (
    <Web3>
      <Gate />
    </Web3>
  );
}

function Gate() {
  const { runId = "" } = useParams();
  const wallet = useWalletSession();
  if (!wallet.session) {
    return (
      <section className={styles.page}>
        <header className={styles.head}>
          <h1>Dry Run report</h1>
          <p>A report belongs to the wallet that asked for it. Sign in with that wallet: it signs a message, which is free and moves no funds.</p>
        </header>
        <div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void wallet.ensureSession()} disabled={wallet.busy !== null}>
            {wallet.busy === "signing" ? "Sign the message in your wallet…" : "Sign in"}
          </button>
        </div>
        {wallet.error && <p className={styles.error} role="alert">{wallet.error}</p>}
      </section>
    );
  }
  return <Loader runId={runId} token={wallet.session.token} />;
}

function Loader({ runId, token }: { runId: string; token: string }) {
  const [view, setView] = useState<DryRunView | null>(null);
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const { dryRun } = await fetchDryRun(token, runId);
        if (!alive) return;
        setView(dryRun);
        setError(null);
        if (dryRun.status === "queued" || dryRun.status === "running") {
          timer = window.setTimeout(tick, POLL_MS);
        } else if (dryRun.status === "complete") {
          const loaded = await fetchDryRunReport(token, runId);
          if (alive) setReport(loaded);
        }
      } catch (caught) {
        if (!alive) return;
        if (caught instanceof ApiError && caught.status === 503) timer = window.setTimeout(tick, POLL_MS);
        else setError(caught instanceof ApiError ? (caught.status === 404 ? "This wallet has no Dry Run with this id." : caught.message) : "The report could not be loaded.");
      }
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [runId, token, attempt]);

  if (error) return <Failure message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!view) return <Loading label="Loading the Dry Run…" />;
  if (view.status === "failed") {
    return (
      <section className={styles.page}>
        <header className={styles.head}>
          <h1>This Dry Run did not finish</h1>
          <p>{view.failReason ?? "It stopped without saying why."}</p>
          <p>
            What it cost went back to your balance. <Link to="/dryrun">Start another</Link>
          </p>
        </header>
      </section>
    );
  }
  if (view.status !== "complete") {
    return (
      <section className={styles.page}>
        <header className={styles.head}>
          <h1>{view.status === "queued" ? "Waiting in the queue" : "The crowd is trying it"}</h1>
          <p role="status">
            {view.progress ? `Round ${view.progress.round} of ${view.progress.rounds}.` : "It starts when a runner picks it up."} This page updates by itself.
          </p>
        </header>
      </section>
    );
  }
  if (!report) return <Loading label="Loading the report…" />;
  return <Report report={report} />;
}

function Report({ report }: { report: DryRunReport }) {
  const check = useMemo(() => verifyRunHash(report as unknown as Record<string, unknown>), [report]);
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of report.findings) counts[finding.severity]++;
  const functions = useMemo(() => byFunction(report), [report]);
  const held = report.invariants.filter((item) => item.held).length;
  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Dry Run report</h1>
        <p>{report.description.split("\n", 1)[0]}</p>
        <p className={styles.meta}>
          <span>{report.crowd.size} synthetic users</span>
          <span>{report.rounds.length} rounds</span>
          <span>{report.calls.length} calls</span>
          <span>model: {report.crowd.model}</span>
          <span>{formatDate(report.createdAt)}</span>
          <span className="mono">{shortHash(report.target.address, 6, 4)}</span>
          {report.status === "partial" && <span>stopped early ({report.stopReason})</span>}
        </p>
      </header>

      <section className={styles.counts} aria-label="What was found">
        {(["high", "medium", "low", "info"] as const).map((level) => (
          <div key={level}>
            <b className={`num ${counts[level] > 0 && level === "high" ? styles.bad : ""}`}>{counts[level]}</b>
            <span>{level === "info" ? "To note" : `${level[0]!.toUpperCase()}${level.slice(1)}`}</span>
          </div>
        ))}
      </section>

      <section className={styles.section} aria-labelledby="findings">
        <h2 id="findings">What the crowd ran into</h2>
        {report.findings.length === 0 ? (
          <p className={styles.small}>Nothing stood out. That says what this crowd happened to try, not that the contract is safe.</p>
        ) : (
          <ol className={styles.findings}>
            {report.findings.map((finding, index) => (
              <FindingItem key={`${finding.kind}-${index}`} finding={finding} />
            ))}
          </ol>
        )}
      </section>

      {report.invariants.length > 0 && (
        <section className={styles.section} aria-labelledby="invariants">
          <h2 id="invariants">
            Invariants: {held} of {report.invariants.length} held
          </h2>
          <ul className={styles.list}>
            {report.invariants.map((item) => (
              <li key={item.name}>
                <span>
                  <span className="mono">{item.name}()</span> <span className={item.held ? styles.good : styles.bad}>{item.held ? "held throughout" : "did not hold"}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section} aria-labelledby="functions">
        <h2 id="functions">What the crowd called</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Function</th>
                <th scope="col" className={styles.right}>Went through</th>
                <th scope="col" className={styles.right}>Reverted</th>
                <th scope="col" className={styles.right}>Refused</th>
                <th scope="col" className={styles.right}>Typical gas</th>
              </tr>
            </thead>
            <tbody>
              {functions.map((row) => (
                <tr key={row.name}>
                  <td className="mono">{row.name}</td>
                  <td className={`num ${styles.right}`}>{row.ok}</td>
                  <td className={`num ${styles.right}`}>{row.reverted}</td>
                  <td className={`num ${styles.right}`}>{row.invalid}</td>
                  <td className={`num ${styles.right}`}>{row.gas === null ? "n/a" : row.gas.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.actionSpace.keptForTheOwner.length > 0 && (
          <p className={styles.small}>
            Kept out of the crowd's hands, and tried once from a stranger's wallet: {report.actionSpace.keptForTheOwner.join(", ")}.
          </p>
        )}
      </section>

      {report.feedback.length > 0 && (
        <section className={styles.section} aria-labelledby="feedback">
          <h2 id="feedback">What the users said</h2>
          <ul className={styles.quotes}>
            {report.feedback.map((line) => (
              <li key={`${line.agentId}-${line.round}-${line.text}`}>
                <span>{line.text}</span>
                <span className={styles.small}>
                  {personaLabel(line.persona)}, round {line.round}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className={styles.small}>
        <span className="mono">{shortHash(report.hash, 10, 8)}</span> {check.ok ? "This file matches its hash, checked in your browser." : "This file does not match its hash."}
      </p>
      <p className={styles.small}>{report.disclaimer}</p>
    </article>
  );
}

function FindingItem({ finding }: { finding: Finding }) {
  return (
    <li className={styles.finding}>
      <span className={`${styles.tag} ${styles[finding.severity]}`}>{finding.severity === "info" ? "To note" : finding.severity}</span>
      <h3>{finding.title}</h3>
      <p>{finding.detail}</p>
      {finding.reproduce.length > 0 && (
        <details>
          <summary>How to reproduce it ({finding.reproduce.length} {finding.reproduce.length === 1 ? "call" : "calls"})</summary>
          <ol className={`${styles.steps} mono`}>
            {finding.reproduce.map((step, index) => (
              <li key={index}>
                {step.agentId}: {step.function}
                {step.args.length > 0 && ` with ${JSON.stringify(step.args)}`}
                {step.valueWei !== "0" && `, sending ${step.valueWei} wei`}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function byFunction(report: DryRunReport) {
  const rows = new Map<string, { name: string; ok: number; reverted: number; invalid: number; gas: number[] }>();
  for (const call of report.calls) {
    const name = call.function || "(not a function)";
    const row = rows.get(name) ?? { name, ok: 0, reverted: 0, invalid: 0, gas: [] };
    row[call.status]++;
    if (call.status === "ok" && call.gasUsed) row.gas.push(call.gasUsed);
    rows.set(name, row);
  }
  return [...rows.values()]
    .sort((a, b) => b.ok + b.reverted - (a.ok + a.reverted))
    .map((row) => ({ ...row, gas: row.gas.length ? [...row.gas].sort((a, b) => a - b)[Math.floor(row.gas.length / 2)]! : null }));
}
