import {
  formatUtcDay,
  measuredLine,
  parseQuery,
  searchSnapshot,
  shortName,
  SNAPSHOT,
  SOURCES,
  STOCK_FACTORY,
} from "@hyvo/stocks";
import { useDeferredValue, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { addressUrl } from "../../lib/explorer";
import { shortHash } from "../../lib/format";
import { loadFactoryCount } from "../../lib/stocks";
import { useAsync } from "../../lib/use-async";
import { useDescription, useTitle } from "../../lib/use-title";
import styles from "./Stocks.module.css";

const TOTAL = SNAPSHOT.tokens.length;
const SCAN_DAY = formatUtcDay(Date.parse(SNAPSHOT.time) / 1000);
const ALPHABETICAL = [...SNAPSHOT.tokens].sort((a, b) => a.symbol.localeCompare(b.symbol));
const FIRST_ROWS = 24;

/** /stocks: look a Robinhood stock token up by ticker or address, or browse every one. */
export function StocksPage() {
  useTitle("Stocks");
  useDescription(
    "Look up a Robinhood stock token on Robinhood Chain by ticker or address: whether the Stock Token factory records it, its multiplier, its Chainlink price and what it means, whether it can move right now, and its multiplier changes.",
  );
  const [params] = useSearchParams();
  // /stocks?q=… opens with the list filtered, as a "not found" page links it.
  const [text, setText] = useState(params.get("q") ?? "");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const deferred = useDeferredValue(text);
  const inputId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = parseQuery(text);
    if (query.kind === "empty") return setError("Type a ticker, such as NVDA, or paste a contract address.");
    if (query.kind === "invalid") return setError(query.reason);
    setError(null);
    navigate(`/stocks/${query.kind === "address" ? query.address : query.ticker}`, { viewTransition: true });
  };

  const change = (value: string) => {
    setText(value);
    if (error) setError(null);
  };

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Stocks</h1>
        <p>
          Robinhood&apos;s stock tokens, read from Robinhood Chain: whether a contract is the one the Stock Token factory records for its ticker, its
          multiplier, what its Chainlink price means, whether it can move right now, and every multiplier change.
        </p>
      </header>

      <form className={styles.search} role="search" onSubmit={submit} noValidate>
        <label htmlFor={inputId}>Ticker or contract address</label>
        <div className={styles.bar}>
          <input
            id={inputId}
            value={text}
            onChange={(event) => change(event.target.value)}
            placeholder="NVDA or 0x…"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="search"
            aria-invalid={Boolean(error)}
            aria-describedby={`${inputId}-help`}
          />
          <button type="submit" className="btn btn-primary">
            Look up
          </button>
        </div>
        {error ? (
          <p id={`${inputId}-help`} className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <p id={`${inputId}-help`} className={styles.hint}>
            Typing filters the list below. An address checks any contract, listed or not.
          </p>
        )}
      </form>

      <TokenList filter={deferred} />

      <section className={styles.how} aria-labelledby="stocks-how">
        <h2 id="stocks-how">Where these facts come from</h2>
        <ul className={styles.sourceList}>
          <li>
            <b>The Stock Token factory</b>
            <p>
              One contract,{" "}
              <a href={addressUrl(STOCK_FACTORY)} target="_blank" rel="noreferrer" className="mono">
                {shortHash(STOCK_FACTORY, 4, 4)}
              </a>
              , deployed every token here and records each one under its uid. A copy can borrow a ticker, a name and even a uid, but not the
              factory&apos;s record, so that record is the check.
            </p>
          </li>
          <li>
            <b>The tokens themselves</b>
            <p>
              Each token is a proxy of one Stock contract, whose{" "}
              <a href={SOURCES.stockSource} target="_blank" rel="noreferrer">
                source is verified on Sourcify
              </a>
              . Its multiplier follows{" "}
              <a href={SOURCES.erc8056} target="_blank" rel="noreferrer">
                ERC-8056
              </a>
              . Every token page reads it again, live.
            </p>
          </li>
          <li>
            <b>Chainlink&apos;s feeds</b>
            <p>
              Prices are read on-chain from Chainlink&apos;s feeds for Robinhood tokens, at the addresses Chainlink lists in its directory.{" "}
              <a href={SOURCES.chainlinkRobinhood} target="_blank" rel="noreferrer">
                Chainlink explains what they report
              </a>
              .
            </p>
          </li>
          <li>
            <b>This list and the history</b>
            <p>
              Found by reading the chain alone, up to block {SNAPSHOT.block.toLocaleString("en-US")}: the factory&apos;s deployments, then every change
              each token recorded. No price, list or verdict here comes from Robinhood&apos;s own website or API.
            </p>
          </li>
        </ul>
      </section>

      <p className={styles.fine}>{measuredLine(SNAPSHOT.block)}</p>
    </article>
  );
}

/** The first rows, alphabetically, until asked for all; every match while filtering. */
function TokenList({ filter }: { filter: string }) {
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const reveal = useRef(false);
  const filtering = filter.trim() !== "";
  const tokens = filtering ? searchSnapshot(filter) : ALPHABETICAL;
  const shown = filtering || showAll ? tokens : tokens.slice(0, FIRST_ROWS);

  // "Show all" leaves the page: focus moves to the first row it revealed.
  useEffect(() => {
    if (!showAll || !reveal.current) return;
    reveal.current = false;
    listRef.current?.querySelectorAll("a")[FIRST_ROWS]?.focus();
  }, [showAll]);

  return (
    <section className={styles.listSection} aria-labelledby="stocks-list">
      <div className={styles.listHead}>
        <h2 id="stocks-list">{filtering ? `${tokens.length} of ${TOTAL} stock tokens` : `${TOTAL} stock tokens`}</h2>
        <p>
          Every token the Stock Token factory deployed up to block {SNAPSHOT.block.toLocaleString("en-US")} ({SCAN_DAY}). Names leave out the “• Robinhood
          Token” each of them ends with.
        </p>
        <FactoryCheck />
      </div>
      {tokens.length > 0 ? (
        <div>
          <div className={styles.columns} aria-hidden="true">
            <span>Ticker</span>
            <span>Name</span>
            <span>Contract</span>
            <span>Multiplier changes</span>
          </div>
          <ul className={styles.list} ref={listRef}>
            {shown.map((token) => (
              <li key={token.address}>
                <Link to={`/stocks/${token.symbol}`} viewTransition>
                  <span className={styles.ticker}>{token.symbol}</span>
                  <span className={styles.name}>{shortName(token.name)}</span>
                  <span className={`${styles.short} mono`}>
                    <span className="visually-hidden">Contract </span>
                    {shortHash(token.address, 6, 4)}
                  </span>
                  <span className={`${styles.changes} num`}>
                    {token.multiplierUpdates.length === 0 ? (
                      <>
                        <span aria-hidden="true">None</span>
                        <span className="visually-hidden">No multiplier changes</span>
                      </>
                    ) : (
                      `${token.multiplierUpdates.length} ${token.multiplierUpdates.length === 1 ? "change" : "changes"}`
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {shown.length < tokens.length && (
            <div className={styles.more}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  reveal.current = true;
                  setShowAll(true);
                }}
              >
                Show all {tokens.length}
              </button>
              <span>
                {shown.length} of {tokens.length}, A to Z
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className={styles.empty}>
          No ticker or name in the list contains “{filter.trim()}”. A contract deployed after block {SNAPSHOT.block.toLocaleString("en-US")} can still be looked up
          by its address.
        </p>
      )}
    </section>
  );
}

/** Whether the factory has deployed anything since the list was made: its nonce, read live. */
function FactoryCheck() {
  const state = useAsync(loadFactoryCount, "factory-count");
  if (state.status === "loading") {
    return (
      <p className={styles.live} role="status">
        Asking the factory whether it has deployed anything since…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className={styles.live} role="status">
        The chain could not be read to check for newer tokens.{" "}
        <button type="button" className={styles.copy} onClick={state.reload}>
          Try again
        </button>
      </p>
    );
  }
  const newer = state.data.nonce - SNAPSHOT.factoryNonce;
  const at = Number(state.data.block).toLocaleString("en-US");
  return (
    <p className={styles.live} role="status">
      {newer <= 0
        ? `Read live at block ${at}: the factory has deployed nothing since.`
        : `Read live at block ${at}: the factory has deployed ${newer} more ${newer === 1 ? "token" : "tokens"} since. Look ${newer === 1 ? "it" : "them"} up by address.`}
    </p>
  );
}
