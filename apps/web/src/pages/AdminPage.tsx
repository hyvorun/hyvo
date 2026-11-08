import type { AdminOverviewResponse, OpenQuestion, QuestionOutcome, RefundView } from "@hyvo/schema";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Failure, Loading } from "../components/States";
import { useWalletSession, Web3 } from "../components/Web3";
import { ApiError, fetchAdminOverview, recordRefund, resolveQuestion, setQueuePaused } from "../lib/api";
import { txUrl } from "../lib/explorer";
import { formatTokenAmount, formatUsd } from "../lib/draft";
import { formatDate, shortHash } from "../lib/format";
import styles from "./AdminPage.module.css";

export function AdminPage() {
  return (
    <Web3>
      <Admin />
    </Web3>
  );
}

type Load = { status: "idle" } | { status: "loading" } | { status: "ready"; data: AdminOverviewResponse } | { status: "error"; message: string };

function Admin() {
  const wallet = useWalletSession();
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const token = wallet.session?.admin ? wallet.session.token : null;

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      setLoad({ status: "ready", data: await fetchAdminOverview(token) });
    } catch (error) {
      setLoad({ status: "error", message: error instanceof ApiError ? error.message : "The overview could not be loaded." });
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!wallet.session) {
    return (
      <section className={styles.gate}>
        <h1>Admin</h1>
        <p>For founder wallets only. Sign in with the wallet: it signs a message, which is free and moves no funds.</p>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void wallet.ensureSession()} disabled={wallet.busy !== null}>
          {wallet.busy === "connecting" ? "Connecting…" : wallet.busy === "signing" ? "Sign the message in your wallet…" : "Sign in"}
        </button>
        {wallet.error && <p className={styles.error}>{wallet.error}</p>}
      </section>
    );
  }
  if (!wallet.session.admin) {
    return (
      <section className={styles.gate}>
        <h1>Admin</h1>
        <p>
          <span className="mono">{shortHash(wallet.session.address, 6, 4)}</span> is not an admin wallet.
        </p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={wallet.signOut}>
          Sign out
        </button>
      </section>
    );
  }
  if (load.status === "idle" || load.status === "loading") return <Loading label="Loading the overview…" />;
  if (load.status === "error") return <Failure message={load.message} onRetry={() => void refresh()} />;

  const data = load.data;
  const capUsed = data.queue.dailyCapUsd > 0 ? Math.min(1, data.queue.spendTodayUsd / data.queue.dailyCapUsd) : 1;
  const due = data.refunds.filter((refund) => refund.status === "due");
  const sent = data.refunds.filter((refund) => refund.status === "sent");

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Admin</h1>
        <p className={styles.meta}>
          {formatDate(data.now)} · payments {on(data.features.payments)} · oracle {on(data.features.oracle)} · holder benefits{" "}
          {on(data.features.holder)}
        </p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      <section className={styles.cards} aria-label="Overview">
        <div className={styles.card}>
          <h2>Queue</h2>
          <p className={styles.big}>
            <span className="mono">{data.queue.queued}</span> queued · <span className="mono">{data.queue.running}</span> running
          </p>
          <p className={styles.small}>{data.queue.paused ? "Paused: no new jobs are handed out." : "Handing out jobs."}</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await setQueuePaused(token!, !data.queue.paused).catch(() => undefined);
              await refresh();
            }}
          >
            {data.queue.paused ? "Resume the queue" : "Pause the queue"}
          </button>
        </div>
        <div className={styles.card}>
          <h2>LLM spend today</h2>
          <p className={styles.big}>
            <span className="mono">{formatUsd(data.queue.spendTodayUsd)}</span> of {formatUsd(data.queue.dailyCapUsd)}
          </p>
          <div className={styles.meter} role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={capUsed}>
            <span style={{ width: `${capUsed * 100}%` }} />
          </div>
          <p className={styles.small}>Reserved at each run's budget, then its real cost. The queue pauses at the cap.</p>
        </div>
        <div className={styles.card}>
          <h2>Fees received (before refunds)</h2>
          <p className={styles.big}>
            <span className="mono">{formatUsd(data.fees.todayUsd)}</span> today
          </p>
          <p className={styles.small}>
            {formatUsd(data.fees.last30dUsd)} and {data.fees.paymentsLast30d} payments in 30 days
          </p>
        </div>
        <div className={styles.card}>
          <h2>Runs, 7 days</h2>
          <p className={styles.big}>
            <span className="mono">{data.jobs.completeLast7d}</span> complete · <span className="mono">{data.jobs.partialLast7d}</span>{" "}
            partial · <span className="mono">{data.jobs.failedLast7d}</span> failed
          </p>
          <p className={styles.small}>
            Oracle: {data.oracle.pending} pending, {data.oracle.failed} failed
            {data.oracle.lastError && <> · last error: {data.oracle.lastError}</>}
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="refunds">
        <h2 id="refunds">Refunds due ({due.length})</h2>
        <p className={styles.small}>
          Send these by hand from the treasury, then record the transaction here (docs/RUNBOOK.md, "Refunds").
        </p>
        {due.length === 0 ? <p className={styles.empty}>Nothing is due.</p> : due.map((refund) => <DueRefund key={refund.id} refund={refund} token={token!} onDone={refresh} />)}
        {sent.length > 0 && (
          <details>
            <summary>Sent in the last 30 days ({sent.length})</summary>
            <ul className={styles.list}>
              {sent.map((refund) => (
                <li key={refund.id}>
                  <span className="mono">{refundAmount(refund)}</span> to <span className="mono">{shortHash(refund.address, 6, 4)}</span>{" "}
                  · {refund.reason.replace(/_/g, " ")} ·{" "}
                  {refund.txHash && (
                    <a href={txUrl(refund.txHash)} target="_blank" rel="noreferrer" className="mono">
                      {shortHash(refund.txHash, 6, 4)}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className={styles.section} aria-labelledby="questions">
        <h2 id="questions">Questions past their date ({data.questionsDue?.length ?? 0})</h2>
        <p className={styles.small}>
          What you record here goes on-chain with the attester key, for good, and on the public calibration page. A miss counts as much as a hit. Use void only
          when the question itself turned out to be unanswerable.
        </p>
        {!data.questionsDue?.length ? (
          <p className={styles.empty}>Nothing is waiting.</p>
        ) : (
          data.questionsDue.map((question) => <DueQuestion key={question.runId} question={question} token={token!} onDone={refresh} />)
        )}
      </section>

      <section className={styles.section} aria-labelledby="failures">
        <h2 id="failures">Recent failures</h2>
        {data.failures.length === 0 ? (
          <p className={styles.empty}>No failed runs.</p>
        ) : (
          <ul className={styles.list}>
            {data.failures.map((failure) => (
              <li key={failure.runId}>
                <Link to={`/run/${failure.runId}`} className="mono">
                  {failure.runId}
                </Link>{" "}
                · {formatDate(failure.failedAt)} · {failure.reason}
                {failure.refund && <> · refund {failure.refund}</>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function DueQuestion({ question, token, onDone }: { question: OpenQuestion; token: string; onDone: () => Promise<void> }) {
  const [outcome, setOutcome] = useState<QuestionOutcome>("yes");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={styles.refund}
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await resolveQuestion(token, question.runId, { outcome, note: note.trim(), ...(evidence.trim() ? { evidenceUrl: evidence.trim() } : {}) });
          await onDone();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "The outcome could not be recorded.");
        }
      }}
    >
      <p>
        {question.question}
        <span className={styles.small}>
          {" "}
          · the crowd: {question.yes} yes, {question.no} no, {question.unsure} unsure · date {formatDate(question.resolvesAt)} ·{" "}
          <Link to={`/run/${question.runId}`}>run</Link>
        </span>
      </p>
      <div className={styles.refundRow}>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as QuestionOutcome)} aria-label="Outcome">
          <option value="yes">Yes</option>
          <option value="no">No</option>
          <option value="void">Void</option>
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="how you know, in a sentence" aria-label="Why" maxLength={500} />
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="a link to the evidence (optional)" aria-label="Evidence link" maxLength={300} />
        <button type="submit" className="btn btn-ghost btn-sm" disabled={!note.trim()}>
          Record on-chain
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </form>
  );
}

function DueRefund({ refund, token, onDone }: { refund: RefundView; token: string; onDone: () => Promise<void> }) {
  const [tx, setTx] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const valid = /^0x[0-9a-f]{64}$/.test(tx.trim().toLowerCase());
  return (
    <form
      className={styles.refund}
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await recordRefund(token, refund.id, tx.trim().toLowerCase(), note.trim());
          await onDone();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "The refund could not be recorded.");
        }
      }}
    >
      <p>
        <span className="mono">{refundAmount(refund)}</span> to <span className="mono">{refund.address}</span>
        <span className={styles.small}>
          {" "}
          · {refund.reason.replace(/_/g, " ")} · {formatDate(refund.createdAt)}
          {refund.runId && (
            <>
              {" "}
              · <Link to={`/run/${refund.runId}`}>run</Link>
            </>
          )}
        </span>
      </p>
      <div className={styles.refundRow}>
        <input className="mono" value={tx} onChange={(e) => setTx(e.target.value)} placeholder="refund transaction hash 0x…" aria-label="Refund transaction hash" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" aria-label="Note" maxLength={500} />
        <button type="submit" className="btn btn-ghost btn-sm" disabled={!valid}>
          Record as sent
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </form>
  );
}

/** An amount to send by hand must be unmistakable: a token the API does not know stays in base units. */
function refundAmount(refund: RefundView): string {
  return refund.decimals === null
    ? `${refund.amount} base units of ${refund.token}`
    : `${formatTokenAmount(refund.amount, refund.decimals)} ${refund.symbol}`;
}

function on(value: boolean): string {
  return value ? "on" : "off";
}
