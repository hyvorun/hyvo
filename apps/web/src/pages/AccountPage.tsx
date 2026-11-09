import type { ApiKeyView, BalanceResponse, HealthResponse, TopUp } from "@hyvo/schema";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { Address, Hex } from "viem";
import { useWalletSession, Web3 } from "../components/Web3";
import { Disclaimer } from "../components/Disclaimer";
import { Copied } from "../components/motion-data/Copied";
import { ApiError, checkTopUp, createApiKey, fetchApiKeys, fetchBalance, fetchHealth, requestTopUp, revokeApiKey } from "../lib/api";
import { formatUsd } from "../lib/draft";
import { txUrl } from "../lib/explorer";
import { formatDate, shortHash } from "../lib/format";
import { payThroughRouter } from "../lib/pay";
import { useTitle } from "../lib/use-title";
import { walletMessage } from "../lib/wallet";
import styles from "./AccountPage.module.css";

export function AccountPage() {
  useTitle("API keys and balance");
  return (
    <Web3>
      <Account />
    </Web3>
  );
}

function Account() {
  const wallet = useWalletSession();
  const token = wallet.session?.token ?? null;

  if (!wallet.session || !token) {
    return (
      <section className={styles.gate}>
        <h1>API keys and balance</h1>
        <p>
          For programs that start runs on their own. Sign in with the wallet that pays: it signs a message, which is free and moves no
          funds. <Link to="/docs">How the API works</Link>
        </p>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void wallet.ensureSession()} disabled={wallet.busy !== null}>
          {wallet.busy === "connecting" ? "Connecting…" : wallet.busy === "signing" ? "Sign the message in your wallet…" : "Sign in"}
        </button>
        {wallet.error && <p className={styles.error} role="alert">{wallet.error}</p>}
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <header className={styles.head}>
        <h1>API keys and balance</h1>
        <p className={styles.small}>
          Signed in as <span className="mono">{shortHash(wallet.session.address, 6, 4)}</span>{" "}
          <button type="button" className={styles.link} onClick={wallet.signOut}>
            Sign out
          </button>
        </p>
      </header>
      <Balance token={token} account={wallet.session.address as Address} />
      <Keys token={token} />
      <Disclaimer />
    </section>
  );
}

type Pay =
  | { step: "idle" }
  | { step: "busy"; stage: string; tx?: Hex }
  | { step: "failed"; message: string; topUp?: TopUp; tx?: Hex };

function Balance({ token, account }: { token: string; account: Address }) {
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState("5");
  const [pay, setPay] = useState<Pay>({ step: "idle" });

  const refresh = useCallback(() => {
    fetchBalance(token).then(
      (next) => {
        setBalance(next);
        setLoadError(null);
      },
      (error: unknown) => setLoadError(error instanceof ApiError ? error.message : "The balance could not be loaded."),
    );
  }, [token]);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    fetchHealth().then(setHealth, () => setHealth(null));
  }, []);

  /** Ask the API about the payment until it has seen it: a few confirmations. */
  const confirm = async (topUp: TopUp, tx: Hex) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const result = await checkTopUp(token, topUp.orderId, tx);
        if (result.check === "paid") return;
        if (result.check === "mismatch" || result.check === "failed" || result.check === "no_payment") throw new ApiError(409, result.message);
      } catch (error) {
        // The payment is on chain: a network or server hiccup here only means asking again.
        if (!(error instanceof ApiError) || (error.status !== 0 && error.status < 500)) throw error;
      }
      await new Promise((done) => setTimeout(done, 2000));
    }
    throw new ApiError(504, "The payment is on chain, but the API has not confirmed it yet. Check again in a minute.");
  };

  const topUp = async (event: FormEvent) => {
    event.preventDefault();
    const amountUsd = Number(amount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return setPay({ step: "failed", message: "Enter an amount in dollars, such as 5." });
    setPay({ step: "busy", stage: "Getting a payment order…" });
    let order: TopUp | undefined;
    let sent: Hex | undefined;
    try {
      order = (await requestTopUp(token, amountUsd)).topUp;
      const tx = await payThroughRouter(
        { orderId: order.orderId, account, token: order.token, router: order.paymentRouter, amount: order.amount, what: "this top-up" },
        {
          stage: (stage, hash) => setPay({ step: "busy", stage, ...(hash ? { tx: hash } : {}) }),
          sent: (hash) => {
            sent = hash;
            setPay({ step: "busy", stage: "Payment sent. Waiting for the API to see it on chain…", tx: hash });
          },
        },
      );
      await confirm(order, tx);
      setPay({ step: "idle" });
      refresh();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : walletMessage(error);
      setPay({ step: "failed", message, ...(order ? { topUp: order } : {}), ...(sent ? { tx: sent } : {}) });
    }
  };

  const recheck = async (order: TopUp, tx: Hex) => {
    setPay({ step: "busy", stage: "Asking the API about the payment…", tx });
    try {
      await confirm(order, tx);
      setPay({ step: "idle" });
      refresh();
    } catch (error) {
      setPay({ step: "failed", message: error instanceof ApiError ? error.message : walletMessage(error), topUp: order, tx });
    }
  };

  const open = health?.features.payments === true;
  return (
    <section className={styles.block} aria-labelledby="balance">
      <h2 id="balance">Balance</h2>
      {loadError && <p className={styles.error} role="alert">{loadError}</p>}
      <p className={styles.big}>{balance ? formatUsd(balance.balanceUsd) : "…"}</p>
      <p className={styles.small}>
        Prepaid credit for runs and questions. It earns nothing, and the funds go to the treasury when you pay. A run that fails goes
        back to the balance.
      </p>
      {health && !open && <p className={styles.small}>Top-ups are not open yet.</p>}
      {open && (
        <form className={styles.form} onSubmit={(event) => void topUp(event)}>
          <label className={styles.field}>
            <span>Top up, in USD</span>
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" disabled={pay.step === "busy"} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pay.step === "busy"}>
            Pay with USDG
          </button>
        </form>
      )}
      {pay.step === "busy" && (
        <p className={styles.small} role="status">
          {pay.stage}{" "}
          {pay.tx && (
            <a href={txUrl(pay.tx)} target="_blank" rel="noreferrer" className="mono">
              {shortHash(pay.tx, 6, 4)}
            </a>
          )}
        </p>
      )}
      {pay.step === "failed" && (
        <div className={styles.failed}>
          <p className={styles.error} role="alert">{pay.message}</p>
          {pay.tx && pay.topUp && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void recheck(pay.topUp!, pay.tx!)}>
              Check the payment again
            </button>
          )}
        </div>
      )}
      {balance && balance.entries.length > 0 && (
        <table className={styles.table}>
          <caption className={styles.hidden}>Balance history</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col" className={styles.right}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {balance.entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDate(entry.createdAt)}</td>
                <td>
                  {REASONS[entry.reason]}
                  {entry.runId && (
                    <>
                      {" "}
                      <Link to={`/run/${entry.runId}`} className="mono">
                        {shortHash(entry.runId, 8, 4)}
                      </Link>
                    </>
                  )}
                </td>
                <td className={`num ${styles.right}`}>
                  {entry.deltaUsd > 0 ? "+" : "−"}
                  {formatUsd(Math.abs(entry.deltaUsd))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const REASONS: Record<BalanceResponse["entries"][number]["reason"], string> = {
  topup: "Top-up",
  run: "Run",
  run_failed: "Run failed, returned",
  ask: "Question",
  ask_returned: "Question not answered, returned",
};

function Keys({ token }: { token: string }) {
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    fetchApiKeys(token).then(
      (next) => setKeys(next.keys),
      (failure: unknown) => setError(failure instanceof ApiError ? failure.message : "The keys could not be loaded."),
    );
  }, [token]);

  useEffect(refresh, [refresh]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const { key } = await createApiKey(token, label.trim());
      setFresh(key);
      setLabel("");
      refresh();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "The key could not be made.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await revokeApiKey(token, id);
      refresh();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "The key could not be revoked.");
    }
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
    } catch {
      // Blocked clipboard: the key stays on screen to select by hand.
    }
  };

  return (
    <section className={styles.block} aria-labelledby="keys">
      <h2 id="keys">API keys</h2>
      <p className={styles.small}>A key can start runs and spend this balance. Keep it out of anything public. Making or revoking one takes this signed-in wallet.</p>
      <form className={styles.form} onSubmit={(event) => void create(event)}>
        <label className={styles.field}>
          <span>Name, for you</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} placeholder="my bot" disabled={busy} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          Make a key
        </button>
      </form>
      {fresh && (
        <div className={styles.fresh} role="status">
          <p>This is the only time this key is shown. Copy it now.</p>
          <code className={`mono ${styles.key}`}>{fresh}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
            {copied ? <Copied>Copied</Copied> : "Copy the key"}
          </button>
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {keys && keys.length === 0 && !fresh && <p className={styles.small}>This wallet has no keys yet.</p>}
      {keys && keys.length > 0 && (
        <ul className={styles.keys}>
          {keys.map((key) => (
            <li key={key.id}>
              <span>
                <span className="mono">{key.prefix}…</span>
                {key.label && <span className={styles.label}> {key.label}</span>}
              </span>
              <span className={styles.small}>{key.lastUsedAt ? `used ${formatDate(key.lastUsedAt)}` : `made ${formatDate(key.createdAt)}`}</span>
              <button type="button" className={styles.link} onClick={() => void revoke(key.id)} aria-label={`Revoke ${key.label ?? key.prefix}`}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
