import { RunId, type OracleEntry, type OracleLedgerResponse } from "@hyvo/schema";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Address } from "viem";
import { Disclaimer } from "../components/Disclaimer";
import { CheckMark } from "../components/Icons";
import { Failure, Loading } from "../components/States";
import { ApiError, fetchOracleLedger } from "../lib/api";
import { PINNED_ORACLE } from "../lib/chain";
import { addressUrl, txUrl } from "../lib/explorer";
import { formatDate, shortHash } from "../lib/format";
import { useTitle } from "../lib/use-title";
import { resolveOracle, verifyRun, type Verification } from "../lib/verify";
import styles from "./OraclePage.module.css";

type Check = { runId: string; state: "checking" } | { runId: string; state: "done"; result: Verification } | { runId: string; state: "error"; message: string };

type Ledger =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

export function OraclePage() {
  useTitle("Oracle ledger");
  const [params, setParams] = useSearchParams();
  const [ledger, setLedger] = useState<Ledger>({ status: "loading" });
  const [meta, setMeta] = useState<Pick<OracleLedgerResponse, "chainId" | "oracleAddress"> | null>(null);
  const [entries, setEntries] = useState<OracleEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [input, setInput] = useState(params.get("run") ?? "");
  const [check, setCheck] = useState<Check | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    setLedger({ status: "loading" });
    try {
      const page = await fetchOracleLedger(cursor);
      setMeta({ chainId: page.chainId, oracleAddress: page.oracleAddress });
      setEntries((current) => (cursor ? [...current, ...page.entries] : page.entries));
      setNextCursor(page.nextCursor);
      setLedger({ status: "ready" });
    } catch (error) {
      setLedger({ status: "error", message: error instanceof Error ? error.message : "The ledger could not be loaded." });
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const source = resolveOracle(PINNED_ORACLE, meta?.oracleAddress ?? null);
  const oracle: Address | null = source.address;

  const verify = async (runId: string) => {
    if (!oracle) return;
    setParams({ run: runId }, { replace: true });
    setCheck({ runId, state: "checking" });
    try {
      setCheck({ runId, state: "done", result: await verifyRun(runId, oracle) });
    } catch (error) {
      setCheck({
        runId,
        state: "error",
        message:
          error instanceof ApiError && error.status === 404
            ? "No published run has this id."
            : error instanceof Error
              ? error.message
              : "The check could not run.",
      });
    }
  };

  // Verify the run named in the link once the oracle address is known.
  useEffect(() => {
    const run = params.get("run");
    if (oracle && run && RunId.safeParse(run).success && check === null) void verify(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracle]);

  const valid = RunId.safeParse(input.trim()).success;

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Oracle ledger</h1>
        <p>
          Published runs are committed to the HyvoOracle contract on Robinhood Chain: each run's hash and the hash of its
          scenario, written once and never changed. Anyone can check a run against its commit. The check below runs in your
          browser: it downloads run.json, hashes it, and reads the commit from the chain itself.
        </p>
        {oracle && (
          <p className={styles.contract}>
            HyvoOracle{" "}
            <a className="mono" href={addressUrl(oracle)} target="_blank" rel="noreferrer">
              {oracle}
            </a>{" "}
            · chain {meta?.chainId} ·{" "}
            {source.pinned ? "the address this app was built with" : "as reported by the Hyvo API"}
          </p>
        )}
        {source.conflict && (
          <p className={styles.warning} role="alert">
            The Hyvo API names another oracle contract (<span className="mono">{source.conflict}</span>). This page checks
            against the address it was built with.
          </p>
        )}
      </header>

      <form
        className={styles.verify}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void verify(input.trim());
        }}
      >
        <label htmlFor="verify-run">Verify a run</label>
        <div className={styles.row}>
          <input
            id="verify-run"
            className="mono"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="run_01…"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="btn btn-primary" disabled={!valid || !oracle || check?.state === "checking"}>
            Verify
          </button>
        </div>
        {!oracle && ledger.status === "ready" && <p className={styles.hint}>No oracle contract is configured on this server yet.</p>}
      </form>

      {check && <Result check={check} />}

      <section className={styles.ledger} aria-labelledby="ledger-title">
        <h2 id="ledger-title">Commits</h2>
        {ledger.status === "loading" && entries.length === 0 && <Loading label="Loading the ledger…" />}
        {ledger.status === "error" && <Failure message={ledger.message} onRetry={() => void load(null)} />}
        {ledger.status === "ready" && entries.length === 0 && <p className={styles.empty}>No run has been committed yet.</p>}
        {entries.length > 0 && (
          <ol className={styles.entries}>
            {entries.map((entry) => (
              <Entry key={entry.runId} entry={entry} onVerify={() => verify(entry.runId)} canVerify={Boolean(oracle)} />
            ))}
          </ol>
        )}
        {nextCursor && (
          <button type="button" className={`btn btn-ghost btn-sm ${styles.more}`} onClick={() => void load(nextCursor)} disabled={ledger.status === "loading"}>
            Show older commits
          </button>
        )}
      </section>

      <section className={styles.how} aria-labelledby="how-title">
        <h2 id="how-title">Check it yourself</h2>
        <ol>
          <li>
            Download the run's run.json from <span className="mono">GET /v1/runs/&lt;runId&gt;/artifact</span>.
          </li>
          <li>
            Remove its top-level <span className="mono">hash</span>, serialize the rest with RFC 8785 (JCS), and take keccak256
            of the UTF-8 bytes. That is the run hash; <span className="mono">run.scenario</span> hashed the same way is the
            scenario hash.
          </li>
          <li>
            Encode the run id as bytes32 (the ULID after <span className="mono">run_</span>, as a 128-bit number) and call{" "}
            <span className="mono">getCommit</span> on HyvoOracle. Its reportHash and scenarioHash must equal yours.
          </li>
        </ol>
        <p className={styles.hint}>
          The full procedure, with test vectors, is in the API documentation (docs/API.md, "Verifying a run").
        </p>
      </section>
      <Disclaimer />
    </article>
  );
}

function Entry({ entry, onVerify, canVerify }: { entry: OracleEntry; onVerify: () => void; canVerify: boolean }) {
  return (
    <li className={styles.entry}>
      <div className={styles.entryMain}>
        <Link to={`/run/${entry.runId}`} className={styles.title}>
          {entry.title ?? "Unlisted run"}
        </Link>
        <span className={`${styles.id} mono`}>{entry.runId}</span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Run hash</dt>
          <dd className="mono" title={entry.reportHash}>
            {shortHash(entry.reportHash, 8, 6)}
          </dd>
        </div>
        <div>
          <dt>Transaction</dt>
          <dd className="mono">
            {entry.txHash ? (
              <a href={txUrl(entry.txHash)} target="_blank" rel="noreferrer" title={entry.txHash}>
                {shortHash(entry.txHash, 6, 4)}
              </a>
            ) : (
              "–"
            )}
          </dd>
        </div>
        <div>
          <dt>Committed</dt>
          <dd>{entry.committedAt ? formatDate(entry.committedAt) : entry.status === "failed" ? "retrying" : "pending"}</dd>
        </div>
      </dl>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onVerify} disabled={!canVerify || entry.status !== "confirmed"}>
        Verify
      </button>
    </li>
  );
}

function Result({ check }: { check: Check }) {
  if (check.state === "checking") return <Loading label={`Checking ${check.runId}…`} />;
  if (check.state === "error") return <Failure message={check.message} />;
  const { result } = check;
  return (
    <section className={`${styles.result} ${result.ok ? styles.ok : styles.bad}`} aria-live="polite">
      <h2>{result.ok ? "Verified: the published run matches its on-chain commit" : "Not verified"}</h2>
      <p className={`${styles.id} mono`}>{check.runId}</p>
      <ol className={styles.steps}>
        {result.steps.map((step, i) => (
          <li key={step.label} className={step.ok ? styles.pass : styles.fail} style={{ "--i": i } as React.CSSProperties}>
            <span className={styles.mark} aria-hidden="true">
              {step.ok ? <CheckMark size={13} /> : "×"}
            </span>
            <span>
              {step.label}
              <span className={`${styles.detail} mono`}>{step.detail}</span>
            </span>
            <span className="visually-hidden">{step.ok ? "passed" : "failed"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
