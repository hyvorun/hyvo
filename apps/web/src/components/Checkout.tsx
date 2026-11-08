import type { MeResponse, Order, QuoteRequest } from "@hyvo/schema";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { Address, Hex } from "viem";
import { ApiError, checkPayment, createFreeRun, fetchMe, requestQuote } from "../lib/api";
import { txUrl } from "../lib/explorer";
import { formatTokenAmount, formatUsd } from "../lib/draft";
import { shortHash } from "../lib/format";
import { payThroughRouter } from "../lib/pay";
import { walletMessage } from "../lib/wallet";
import styles from "./Checkout.module.css";
import { useWalletSession } from "./Web3";

type Phase =
  | { step: "idle" }
  | { step: "quoting" }
  | { step: "quoted"; order: Order }
  | { step: "paying"; order: Order; stage: string; tx?: Hex }
  | { step: "waiting"; order: Order; tx: Hex }
  | { step: "failed"; order: Order | null; message: string; tx?: Hex };

/**
 * Price, then pay: sign in with the wallet, get a quote, approve exactly the quoted USDG for the
 * PaymentRouter and call `pay`. The router forwards the payment to the treasury in the same call;
 * Hyvo never holds the tokens. Once the API sees the payment, the run is queued.
 */
export function Checkout({
  request,
  onInvalid,
  draftKey,
}: {
  request: () => QuoteRequest | null;
  onInvalid: () => void;
  /** Changes when the form changes: a price is for the run it was quoted for. */
  draftKey: string;
}) {
  const wallet = useWalletSession();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [me, setMe] = useState<MeResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!wallet.session) return setMe(null);
    fetchMe(wallet.session.token).then(setMe, () => setMe(null));
  }, [wallet.session]);

  useEffect(() => {
    setPhase((current) =>
      current.step === "quoted" || (current.step === "failed" && !current.tx) ? { step: "idle" } : current,
    );
  }, [draftKey]);

  const getPrice = async () => {
    const body = request();
    if (!body) return onInvalid();
    const session = await wallet.ensureSession();
    if (!session) return;
    setPhase({ step: "quoting" });
    try {
      const { order } = await requestQuote(session.token, body);
      setPhase({ step: "quoted", order });
    } catch (error) {
      setPhase({ step: "failed", order: null, message: apiMessage(error) });
    }
  };

  const freeRun = async () => {
    const body = request();
    if (!body) return onInvalid();
    const session = await wallet.ensureSession();
    if (!session) return;
    setPhase({ step: "quoting" });
    try {
      const { runId } = await createFreeRun(session.token, body);
      navigate(`/run/${runId}`);
    } catch (error) {
      setPhase({ step: "failed", order: null, message: apiMessage(error) });
    }
  };

  const pay = async (order: Order) => {
    // Only the wallet that asked for the price can follow its payment and find its run.
    if (wallet.address && wallet.address.toLowerCase() !== order.address.toLowerCase()) {
      const message = `This price is for wallet ${shortHash(order.address, 6, 4)}. Switch back to it, or change the run to get a new price.`;
      return setPhase({ step: "failed", order, message });
    }
    const session = await wallet.ensureSession();
    if (!session) return;
    let tx: Hex | undefined;
    try {
      const mined = await payThroughRouter(
        {
          orderId: order.orderId,
          account: session.address as Address,
          token: order.token,
          router: order.paymentRouter,
          amount: order.amount,
          what: "the run",
        },
        {
          stage: (stage, hash) => setPhase({ step: "paying", order, stage, ...(hash ? { tx: hash } : {}) }),
          sent: (hash) => {
            tx = hash;
            setPhase({ step: "waiting", order, tx: hash });
          },
        },
      );
      const runId = await confirm(session.token, order.orderId, mined);
      navigate(`/run/${runId}`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : walletMessage(error);
      setPhase({ step: "failed", order, message, ...(tx ? { tx } : {}) });
    }
  };

  /** After a payment was sent: ask the API again instead of paying again. */
  const recheck = async (order: Order, tx: Hex) => {
    const session = await wallet.ensureSession();
    if (!session) return;
    setPhase({ step: "waiting", order, tx });
    try {
      navigate(`/run/${await confirm(session.token, order.orderId, tx)}`);
    } catch (error) {
      setPhase({ step: "failed", order, message: apiMessage(error), tx });
    }
  };

  const order = phase.step === "idle" || phase.step === "quoting" ? null : phase.order;
  const expiresIn = order ? Math.max(0, Math.floor((Date.parse(order.expiresAt) - now) / 1000)) : 0;
  const busy = wallet.busy !== null || phase.step === "quoting" || phase.step === "paying" || phase.step === "waiting";
  const holder = me?.holder;
  const freeLeft = holder?.eligible ? holder.freeRunsLeft : 0;
  const freeFits = order && holder ? order.run.agents <= holder.freeRunMax.agents && order.run.rounds <= holder.freeRunMax.rounds : false;

  return (
    <div className={styles.checkout}>
      <div className={styles.wallet}>
        {wallet.session ? (
          <>
            <span className={styles.dot} aria-hidden="true" />
            Signed in as <span className="mono">{shortHash(wallet.session.address, 6, 4)}</span>
            <button type="button" className={styles.link} onClick={wallet.signOut}>
              Sign out
            </button>
          </>
        ) : (
          <span>Your wallet signs a message to sign in. That is free and moves no funds.</span>
        )}
      </div>

      {!order && (
        <div className={styles.actions}>
          <button type="button" className="btn btn-primary" onClick={getPrice} disabled={busy}>
            {wallet.busy === "connecting"
              ? "Connecting your wallet…"
              : wallet.busy === "signing"
                ? "Sign the message in your wallet…"
                : phase.step === "quoting"
                  ? "Getting a price…"
                  : "Get a price"}
          </button>
          {freeLeft > 0 && (
            <button type="button" className="btn btn-ghost" onClick={freeRun} disabled={busy}>
              Use a free run ({freeLeft} left this month)
            </button>
          )}
        </div>
      )}

      {order && (
        <section className={styles.quote} aria-label="Price">
          <div className={styles.price}>
            <span className={styles.amount}>{formatUsd(order.priceUsd)}</span>
            <span className={styles.token}>
              paid as <span className="num">{formatTokenAmount(order.amount, order.token.decimals)}</span> {order.token.symbol}
            </span>
          </div>
          <dl className={styles.terms}>
            <div>
              <dt>Run</dt>
              <dd>
                {order.run.title}: {order.run.agents} agents × {order.run.rounds} rounds,{" "}
                {order.run.listed ? "listed in the gallery" : "unlisted"}
              </dd>
            </div>
            <div>
              <dt>Includes</dt>
              <dd>the crowd, the report, the published run.json and its hash committed on Robinhood Chain</dd>
            </div>
            {order.discountBps > 0 && (
              <div>
                <dt>Holder discount</dt>
                <dd>{order.discountBps / 100}% off</dd>
              </div>
            )}
            <div>
              <dt>Quote</dt>
              <dd>
                {order.status === "expired" || expiresIn === 0
                  ? "expired"
                  : `valid for ${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, "0")}`}
              </dd>
            </div>
          </dl>
          {phase.step === "failed" && phase.tx && (
            <div className={styles.actions}>
              <button type="button" className="btn btn-primary" onClick={() => recheck(order, phase.tx!)} disabled={busy}>
                Check the payment again
              </button>
              <a href={txUrl(phase.tx)} target="_blank" rel="noreferrer" className={styles.link}>
                View the transaction
              </a>
            </div>
          )}
          {(phase.step === "quoted" || (phase.step === "failed" && !phase.tx)) && expiresIn > 0 && (
            <div className={styles.actions}>
              <button type="button" className="btn btn-primary" onClick={() => pay(order)} disabled={busy}>
                Pay {formatTokenAmount(order.amount, order.token.decimals)} {order.token.symbol}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setPhase({ step: "idle" })} disabled={busy}>
                Change the run
              </button>
              {freeLeft > 0 && freeFits && (
                <button type="button" className="btn btn-ghost" onClick={freeRun} disabled={busy}>
                  Use a free run instead ({freeLeft} left this month)
                </button>
              )}
            </div>
          )}
          {expiresIn === 0 && (
            <button type="button" className="btn btn-ghost" onClick={getPrice} disabled={busy}>
              Get a new price
            </button>
          )}
          {(phase.step === "paying" || phase.step === "waiting") && (
            <p className={styles.progress} role="status">
              <span className={styles.pulse} aria-hidden="true" />
              {phase.step === "paying" ? phase.stage : "Payment sent. Waiting for the API to see it on chain…"}
              {phase.tx && (
                <a href={txUrl(phase.tx)} target="_blank" rel="noreferrer" className="mono">
                  {shortHash(phase.tx, 6, 4)}
                </a>
              )}
            </p>
          )}
          <p className={styles.fine}>
            You approve exactly this amount for the PaymentRouter contract, which sends it to the Hyvo treasury in the same
            transaction. Hyvo never holds your tokens. If the run fails, the payment is refunded to this wallet.
          </p>
        </section>
      )}

      {(wallet.error || phase.step === "failed") && (
        <p className={styles.error} role="alert">
          {wallet.error ?? (phase.step === "failed" ? phase.message : "")}
        </p>
      )}
      <p className={styles.fine}>Synthetic crowd reaction. Not a trading signal.</p>
    </div>
  );
}

/** Ask the API about the payment until it has seen it (a few confirmations), then return the run id. */
async function confirm(token: string, orderId: string, tx: Hex): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const result = await checkPayment(token, orderId, tx);
      if (result.check === "paid" && result.order.runId) return result.order.runId;
      if (result.check === "mismatch" || result.check === "failed" || result.check === "no_payment") {
        throw new ApiError(409, result.message);
      }
    } catch (error) {
      // The payment is on chain: a network or server hiccup here only means asking again.
      if (!(error instanceof ApiError) || (error.status !== 0 && error.status < 500)) throw error;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new ApiError(504, "The payment is on chain, but the API has not confirmed it yet. Reload this page in a minute.");
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "payments_disabled") return "Paid runs are not open yet on this server.";
    return error.message;
  }
  return walletMessage(error);
}
