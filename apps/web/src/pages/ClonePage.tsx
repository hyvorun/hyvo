import type { CloneProfile, CloneView } from "@hyvo/schema";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { PaymentsNote } from "../components/PaymentsNote";
import { Failure, Loading } from "../components/States";
import { useWalletSession, Web3 } from "../components/Web3";
import { ApiError, buildClone, deleteClone, fetchClone, startRunFromBalance } from "../lib/api";
import { shortHash } from "../lib/format";
import { useTitle } from "../lib/use-title";
import styles from "./DryRunPage.module.css";

const POLL_MS = 4000;

export function ClonePage() {
  useTitle("Wallet Clone");
  return (
    <Web3>
      <Gate />
    </Web3>
  );
}

function Gate() {
  const wallet = useWalletSession();
  if (!wallet.session) {
    return (
      <section className={styles.page}>
        <header className={styles.head}>
          <h1>Wallet Clone</h1>
          <p>
            See how your own trading style does in a crowd. Hyvo reads your wallet's trades on Robinhood Chain and turns them into numbers: how much you buy, how long you hold, how
            soon you enter. One agent in a crowd then trades by those numbers.
          </p>
          <p>Only your own wallet can be cloned, so it starts with a signature. It is free and moves no funds.</p>
        </header>
        <div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void wallet.ensureSession()} disabled={wallet.busy !== null}>
            {wallet.busy === "connecting" ? "Connecting…" : wallet.busy === "signing" ? "Sign the message in your wallet…" : "Sign in"}
          </button>
        </div>
        {wallet.error && (
          <p className={styles.error} role="alert">
            {wallet.error}
          </p>
        )}
        <Disclaimer />
      </section>
    );
  }
  return <Clone token={wallet.session.token} address={wallet.session.address} />;
}

function Clone({ token, address }: { token: string; address: string }) {
  const [clone, setClone] = useState<CloneView | null>(null);
  const [open, setOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const answer = await fetchClone(token);
      setClone(answer.clone);
      setOpen(answer.open);
      setLoaded(true);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Your clone could not be loaded.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const building = clone?.status === "building";
  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [building, load]);

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      setClone((await buildClone(token)).clone);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The clone could not be started.");
    } finally {
      setBusy(false);
    }
  };

  if (!loaded && error) return <Failure message={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading label="Looking for your clone…" />;

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Wallet Clone</h1>
        <p className={styles.small}>
          Signed in as <span className="mono">{shortHash(address, 6, 4)}</span>
        </p>
        {!clone && open && (
          <p>
            Hyvo reads this wallet's trades on Robinhood Chain and keeps only numbers: no address, no token names, no dates. You can look at them, run them in a crowd, and delete them
            whenever you want.
          </p>
        )}
      </header>

      {!open && !clone && <p role="status">Clones are not open yet.</p>}

      {building && <p role="status">Reading your trades. This page updates by itself.</p>}

      {clone?.status === "failed" && (
        <p className={styles.error} role="alert">
          {clone.failReason ?? "The clone could not be built."}
        </p>
      )}

      {open && !building && clone?.status !== "ready" && (
        <div className={styles.actions}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void build()} disabled={busy}>
            {clone ? "Try again" : "Build my clone"}
          </button>
        </div>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {clone?.profile && clone.status === "ready" && (
        <>
          <Numbers profile={clone.profile} />
          <RunIt token={token} />
          {open && (
            <div className={styles.actions}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void build()} disabled={busy}>
                Read my trades again
              </button>
            </div>
          )}
        </>
      )}

      {clone && <Delete token={token} onDeleted={() => setClone(null)} />}
      <Disclaimer />
    </article>
  );
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function hours(value: number): string {
  if (value < 1) return plural(Math.round(value * 60), "minute");
  if (value >= 48) return plural(Math.round(value / 24), "day");
  return plural(Number(value.toPrecision(2)), "hour");
}

function minutes(value: number): string {
  return value < 120 ? plural(Number(value.toPrecision(2)), "minute") : hours(value / 60);
}

/** Every number the clone trades by, and nothing else: this is all Hyvo keeps. */
function Numbers({ profile }: { profile: CloneProfile }) {
  const rows: [string, string][] = [
    ["Trades", `${profile.trades.toLocaleString("en-US")} (${profile.buys.toLocaleString("en-US")} buys, ${profile.sells.toLocaleString("en-US")} sells) in ${profile.tokens} tokens`],
    ["Typical buy", profile.typicalBuyEth === null ? "not known" : `${profile.typicalBuyEth} ETH${profile.smallBuyEth !== null && profile.largeBuyEth !== null ? `, mostly ${profile.smallBuyEth} to ${profile.largeBuyEth} ETH` : ""}`],
    ["From buying to first selling", profile.medianHoldHours === null ? "no sale on record" : `${hours(profile.medianHoldHours)} (median)`],
    ["First sales within an hour", profile.soldWithinHourPct === null ? "no sale on record" : `${profile.soldWithinHourPct}%`],
    ["Tokens still held", profile.stillHeldPct === null ? "not known" : `${profile.stillHeldPct}%`],
    ["Sold at a time", profile.medianSellPct === null ? "no sale on record" : `${profile.medianSellPct}% of a position (median)`],
    ["Token's age at entry", profile.medianEntryMinutes === null ? "not known" : `${minutes(profile.medianEntryMinutes)} (median)`],
    ["Entries in a token's first hour", profile.earlyEntryPct === null ? "not known" : `${profile.earlyEntryPct}%`],
  ];
  return (
    <section className={styles.section} aria-labelledby="numbers">
      <h2 id="numbers">What the clone trades by</h2>
      <ul className={`${styles.list} ${styles.pairs}`}>
        {rows.map(([label, value]) => (
          <li key={label}>
            <span>{label}</span>
            <span className="num">{value}</span>
          </li>
        ))}
      </ul>
      <p className={styles.small}>These numbers are all Hyvo keeps. They hold no address, no token names and no dates.</p>
    </section>
  );
}

function RunIt({ token }: { token: string }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [seedText, setSeedText] = useState("");
  const [errors, setErrors] = useState<{ title?: string }>({});
  const [failure, setFailure] = useState<{ message: string; short: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    if (!title.trim()) {
      setErrors({ title: "Give the scenario a title." });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const { runId } = await startRunFromBalance(token, {
        balance: true,
        clone: true,
        scenario: { title: title.trim(), seedText: seedText.trim(), events: [] },
        agents: 50,
        rounds: 10,
      });
      navigate(`/run/${runId}`);
    } catch (caught) {
      const api = caught instanceof ApiError ? caught : null;
      setFailure({ message: api?.message ?? "The run could not be started.", short: api?.code === "insufficient_balance" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="run-it">
      <h2 id="run-it">Run it in a crowd</h2>
      <p className={styles.small}>Fifty agents and ten rounds, paid from your balance. One of the agents is your clone, under a generated handle. The run stays out of the gallery.</p>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.field}>
          <label htmlFor="clone-title">Title</label>
          <input id="clone-title" value={title} onChange={(event) => setTitle(event.target.value)} aria-invalid={Boolean(errors.title)} placeholder="A fictional token lists with a 5% tax" />
          {errors.title && <span className={styles.error}>{errors.title}</span>}
        </div>
        <div className={styles.field}>
          <label htmlFor="clone-seed">What the crowd reads before round 1</label>
          <textarea id="clone-seed" rows={4} value={seedText} onChange={(event) => setSeedText(event.target.value)} />
        </div>
        <PaymentsNote className={styles.small} />
        <div className={styles.actions}>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? "Starting…" : "Start the run"}
          </button>
        </div>
        {failure && (
          <p className={styles.error} role="alert">
            {failure.message} {failure.short && <Link to="/account">Top up</Link>}
          </p>
        )}
      </form>
    </section>
  );
}

function Delete({ token, onDeleted }: { token: string; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    try {
      await deleteClone(token);
      setAsking(false);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The clone could not be deleted.");
    }
  };

  return (
    <section className={styles.section} aria-labelledby="delete">
      <h2 id="delete">Delete it</h2>
      <p className={styles.small}>This removes the numbers and every copy of them. A run you already played keeps what its agent did, under its generated handle, and not the numbers it was made from.</p>
      <div className={styles.actions}>
        {asking ? (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()}>
              Delete for good
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(true)}>
            Delete my clone
          </button>
        )}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
