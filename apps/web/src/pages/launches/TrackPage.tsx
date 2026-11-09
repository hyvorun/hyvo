/**
 * Track: follow wallets and see their trades on Pons V2 curves over the last 30,000 blocks, the widest span a log
 * query without an address is answered over (packages/launches/src/track.ts), read in the visitor's browser.
 * Everyone can follow one wallet; HYVO holders follow up to 25, kept with their account.
 */
import { TRACKED_MAX_HOLDER } from "@hyvo/schema";
import { formatAmount, formatTokens, readWalletTrades, shortAddress, TRACK_BLOCKS, type Snapshot, type WalletTrades, type WalletTrade } from "@hyvo/launches";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Failure } from "../../components/States";
import { txUrl } from "../../lib/explorer";
import { useHolderStatus } from "../../lib/holder-status";
import { assetCache, launchesReader } from "../../lib/launches";
import { addTo, removeFrom, trackLimit } from "../../lib/saved-lists";
import { useSavedList } from "../../lib/use-saved-list";
import { useDescription, useTitle } from "../../lib/use-title";
import { HolderSync } from "./HolderSync";
import { Age, BlockLink, pairLabel, Provenance } from "./parts";
import launches from "./Launches.module.css";
import styles from "./Utility.module.css";

type Read = { status: "idle" | "loading" | "ready" | "error"; data: WalletTrades | null; head: Snapshot | null; served: string[]; error: string | null };

const MINUTES = Math.round(Number(TRACK_BLOCKS) / 9.6 / 60);

export function TrackPage() {
  useTitle("Track wallets");
  useDescription("Follow Robinhood Chain wallets and see their trades on Pons curves, read from the chain in your browser. Not a trading signal.");
  const holder = useHolderStatus();
  const saved = useSavedList("tracked", holder);
  const limit = trackLimit(holder.status);
  const followed = saved.list.slice(0, limit);
  const waiting = saved.list.slice(limit);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Read>({ status: "idle", data: null, head: null, served: [], error: null });
  const key = followed.join(",");

  useEffect(() => {
    const wallets = key ? (key.split(",") as `0x${string}`[]) : [];
    if (wallets.length === 0) {
      setState({ status: "idle", data: null, head: null, served: [], error: null });
      return;
    }
    let live = true;
    setState((current) => ({ ...current, status: "loading", error: null }));
    const reader = launchesReader();
    (async () => {
      const top = await reader.header("latest");
      const head = { block: top.number, timestamp: top.timestamp };
      const data = await readWalletTrades(reader, { wallets, fromBlock: head.block - TRACK_BLOCKS + 1n, toBlock: head.block, cache: assetCache });
      if (live) setState({ status: "ready", data, head, served: [...reader.served], error: null });
    })().catch(() => {
      if (live)
        setState((current) => ({
          ...current,
          status: "error",
          error: "The trades could not be read just now: no public endpoint answered a query across every curve. Try again in a moment.",
        }));
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const follow = (event: FormEvent) => {
    event.preventDefault();
    const next = addTo(saved.list.slice(0, limit), input, limit);
    if (next.result === "invalid") return setInputError("A wallet address is 0x followed by 40 hexadecimal characters.");
    if (next.result === "already") return setInputError("You already follow this wallet.");
    if (next.result === "full") {
      return setInputError(
        holder.status === "holder"
          ? `You follow ${TRACKED_MAX_HOLDER} wallets, the most there is room for. Stop following one first.`
          : `Everyone can follow 1 wallet. HYVO holders follow up to ${TRACKED_MAX_HOLDER}: stop following this one first, or sign in with a wallet that holds HYVO.`,
      );
    }
    setInputError(null);
    setInput("");
    saved.set([...next.list, ...waiting]);
  };

  const unfollow = (wallet: `0x${string}`) => saved.set(removeFrom(saved.list, wallet));

  return (
    <article className={launches.page}>
      <nav className={launches.crumbs} aria-label="Breadcrumb">
        <Link to="/launches" viewTransition>
          Launches
        </Link>
        <span aria-hidden="true">/</span>
        <span>Track</span>
      </nav>
      <header className={launches.head}>
        <p className={launches.eyebrow}>Hyvo Launches</p>
        <h1>Track wallets</h1>
        <p className={launches.lead}>
          Follow a wallet and see what it bought and sold on Pons curves in the last {TRACK_BLOCKS.toLocaleString("en-US")} blocks, about {MINUTES} minutes,
          read from the chain in your browser.
        </p>
        <HolderSync holder={holder} sync={saved.sync} syncError={saved.syncError} what="the wallets you follow" />
      </header>

      <section className={launches.section} aria-labelledby="follow-title">
        <div className={launches.sectionHead}>
          <h2 id="follow-title">
            Following {followed.length} of {limit} {limit === 1 ? "wallet" : "wallets"}
          </h2>
          <p>{holder.status === "holder" ? `HYVO holders follow up to ${TRACKED_MAX_HOLDER} wallets.` : `Everyone can follow 1 wallet; HYVO holders follow up to ${TRACKED_MAX_HOLDER}.`}</p>
        </div>
        <form className={styles.follow} onSubmit={follow} noValidate>
          <label htmlFor="follow-wallet">Wallet address</label>
          <div>
            <input
              id="follow-wallet"
              className="mono"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setInputError(null);
              }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={inputError ? true : undefined}
              aria-describedby={inputError ? "follow-error" : undefined}
            />
            <button type="submit" className="btn btn-primary btn-sm">
              Follow
            </button>
          </div>
          {inputError && (
            <p id="follow-error" className={launches.inputError} role="alert">
              {inputError}
            </p>
          )}
        </form>
        {followed.length > 0 && (
          <ul className={styles.list} aria-label="Wallets you follow">
            {followed.map((wallet) => (
              <li key={wallet}>
                <span className={`${styles.item} mono`} title={wallet}>
                  {wallet}
                </span>
                <button type="button" className={styles.remove} onClick={() => unfollow(wallet)} aria-label={`Stop following ${shortAddress(wallet, 6, 4)}`}>
                  Stop following
                </button>
              </li>
            ))}
          </ul>
        )}
        {waiting.length > 0 && (
          <p className={launches.fine}>
            {waiting.length} more saved {waiting.length === 1 ? "wallet is" : "wallets are"} not followed now: HYVO holders follow up to {TRACKED_MAX_HOLDER}.
          </p>
        )}
      </section>

      <section className={launches.section} aria-labelledby="trades-title">
        <div className={launches.sectionHead}>
          <h2 id="trades-title">Their trades on Pons curves</h2>
          <p>
            Every CurveBuy and CurveSell event that names a followed wallet as its buyer, seller or recipient, from a contract the Pons V2 factory records as
            that token&apos;s curve.
          </p>
        </div>
        {followed.length === 0 && <p className={launches.note}>Follow a wallet above to see its trades here.</p>}
        {followed.length > 0 && state.status === "loading" && !state.data && (
          <p className={launches.note} role="status">
            Reading Robinhood Chain…
          </p>
        )}
        {state.status === "error" && <Failure message={state.error ?? "The chain could not be read just now."} onRetry={() => setAttempt((n) => n + 1)} />}
        {state.data && followed.length > 0 && (
          <>
            {state.data.trades.length === 0 ? (
              <p className={launches.note}>
                No trade on a Pons curve by {followed.length === 1 ? "this wallet" : "these wallets"} in blocks {state.data.fromBlock.toLocaleString("en-US")} to{" "}
                {state.data.toBlock.toLocaleString("en-US")}.
              </p>
            ) : (
              <ol className={`${styles.trades} stagger`} aria-label="Trades">
                {state.data.trades.map((trade) => (
                  <TradeRow key={`${trade.txHash}:${trade.logIndex}`} trade={trade} now={state.head?.timestamp ?? 0} />
                ))}
              </ol>
            )}
            {state.data.dropped > 0 && (
              <p className={launches.fine}>
                {state.data.dropped === 1 ? "One other contract" : `${state.data.dropped} other contracts`} sent the same events and{" "}
                {state.data.dropped === 1 ? "is not a Pons curve, so it is" : "are not Pons curves, so they are"} left out.
              </p>
            )}
            <p className={launches.fine}>
              Blocks <BlockLink block={state.data.fromBlock} /> to <BlockLink block={state.data.toBlock} />.
            </p>
          </>
        )}
        {state.head && (
          <Provenance reads={[state.data?.read ?? state.head]} served={state.served}>
            {" "}
            <button type="button" className={launches.again} onClick={() => setAttempt((n) => n + 1)} disabled={state.status === "loading"}>
              Read again
            </button>
          </Provenance>
        )}
      </section>
      <p className={launches.fine}>
        Track shows what the chain recorded; it says nothing about where a price goes. Following a wallet only reads public events: nothing is signed or sent.
      </p>
    </article>
  );
}

function TradeRow({ trade, now }: { trade: WalletTrade; now: number }) {
  const symbol = trade.symbol ?? shortAddress(trade.token);
  const pair = pairLabel(trade.pair);
  const tokens = (value: bigint) => `${formatTokens(value)} ${symbol}`;
  const quote = (value: bigint) => `${formatAmount(value, trade.pair.decimals)} ${pair}`;
  return (
    <li>
      <span className={styles.what}>
        <span className="mono" title={trade.wallet}>
          {shortAddress(trade.wallet, 6, 4)}
        </span>
        <span className={trade.side === "buy" ? styles.bought : styles.sold}>
          <i aria-hidden="true" />
          {trade.side === "buy" ? "bought" : "sold"}
        </span>
        <Link to={`/launches/${trade.token}`} viewTransition>
          <b>{symbol}</b>
        </Link>
        {trade.via && (
          <span className={launches.muted}>
            through <span className="mono">{shortAddress(trade.via, 6, 4)}</span>
          </span>
        )}
      </span>
      <span className={`${styles.amounts} num`}>
        {trade.side === "buy" ? `${quote(trade.amountIn)} in, ${tokens(trade.amountOut)} out` : `${tokens(trade.amountIn)} in, ${quote(trade.amountOut)} out`}
      </span>
      <span className={styles.when}>
        <a href={txUrl(trade.txHash)} target="_blank" rel="noreferrer" title={`Transaction ${trade.txHash}`}>
          block {trade.block.toLocaleString("en-US")}
        </a>
        {trade.timestamp && now > 0 && (
          <>
            , <Age at={trade.timestamp} now={now} /> ago
          </>
        )}
      </span>
    </li>
  );
}
