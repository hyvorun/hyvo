import {
  formatSpan,
  formatUtc,
  groupThousands,
  formatFixed,
  measuredLine,
  multiplierRatio,
  parseQuery,
  relativeTime,
  roundDecimal,
  SESSION_LABELS,
  shortName,
  SNAPSHOT,
  snapshotByAddress,
  snapshotByTicker,
  SOURCES,
  STOCK_FACTORY,
  STOCK_IMPLEMENTATION,
  STOCK_REGISTRY,
  usEquitySession,
  type FeedPart,
  type MultiplierUpdate,
  type SnapshotToken,
  type StockReport,
} from "@hyvo/stocks";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Address } from "viem";
import { Arrow, CheckMark } from "../../components/Icons";
import { Failure } from "../../components/States";
import { addressUrl, txUrl } from "../../lib/explorer";
import { shortHash } from "../../lib/format";
import { loadStockReport } from "../../lib/stocks";
import { useAsync } from "../../lib/use-async";
import { useDescription, useTitle } from "../../lib/use-title";
import styles from "./Stocks.module.css";

const block = (n: bigint | number) => Number(n).toLocaleString("en-US");
const panel = (i: number) => ({ "--i": i }) as CSSProperties;

/** /stocks/:id — one token, by ticker (from Hyvo's list) or by any contract address. */
export function StockPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const query = parseQuery(id);
  const canonical = query.kind === "address" ? query.address : query.kind === "ticker" ? query.ticker : null;

  // One address per token: /stocks/nvda becomes /stocks/NVDA, a lowercase address gets its checksum.
  useEffect(() => {
    if (canonical && canonical !== id) navigate(`/stocks/${canonical}`, { replace: true });
  }, [canonical, id, navigate]);

  if (query.kind === "address") return <Report address={query.address} />;
  if (query.kind === "ticker") {
    const matches = snapshotByTicker(query.ticker);
    if (matches.length === 1) return <Report address={matches[0]!.address} ticker={query.ticker} />;
    if (matches.length > 1) return <SeveralTokens ticker={query.ticker} tokens={matches} />;
    return <NoSuchTicker ticker={query.ticker} />;
  }
  return <NoSuchTicker ticker={id} reason={query.kind === "invalid" ? query.reason : undefined} />;
}

function Crumbs({ label }: { label: string }) {
  return (
    <nav className={styles.crumbs} aria-label="Breadcrumb">
      <Link to="/stocks" viewTransition>
        Stocks
      </Link>
      <span aria-hidden="true">/</span>
      <span>{label}</span>
    </nav>
  );
}

function NoSuchTicker({ ticker, reason }: { ticker: string; reason?: string }) {
  useTitle("Stock not found");
  return (
    <article className={`${styles.page} ${styles.detail}`}>
      <Crumbs label={ticker} />
      <header className={`${styles.head} ${styles.smallHead}`}>
        <h1>{reason ? "Not a ticker or an address" : `No stock token with the ticker ${ticker}`}</h1>
        <p>
          {reason ??
            `Hyvo's list holds every token the Stock Token factory deployed up to block ${block(SNAPSHOT.block)}, and none of them has this ticker. A token deployed since can be looked up by its contract address.`}
        </p>
      </header>
      <Link to="/stocks" className="arrow-link" viewTransition>
        Look up another ticker or address <Arrow />
      </Link>
    </article>
  );
}

function SeveralTokens({ ticker, tokens }: { ticker: string; tokens: SnapshotToken[] }) {
  useTitle(ticker);
  return (
    <article className={`${styles.page} ${styles.detail}`}>
      <Crumbs label={ticker} />
      <header className={`${styles.head} ${styles.smallHead}`}>
        <h1>{tokens.length} tokens use the ticker {ticker}</h1>
        <p>The factory deployed more than one token with this ticker. Hyvo does not choose between them: open each one.</p>
      </header>
      <ul className={styles.choices}>
        {tokens.map((token) => (
          <li key={token.address}>
            <Link to={`/stocks/${token.address}`} className="arrow-link mono" viewTransition>
              {token.address} · {shortName(token.name)}
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}

function Report({ address, ticker }: { address: Address; ticker?: string }) {
  const listed = snapshotByAddress(address);
  const state = useAsync(() => loadStockReport(address), address);
  const report = state.status === "ready" ? state.data : null;
  const registered = report?.verdict.kind === "registered";
  const symbol = registered ? report!.reading.token!.symbol : (listed?.symbol ?? null);
  useTitle(symbol ?? `Contract ${shortHash(address, 4, 4)}`);
  useDescription(
    `${symbol ?? address} on Robinhood Chain: whether the Stock Token factory records it, its multiplier, its Chainlink price, whether it can move right now, and its multiplier changes. Measured on-chain.`,
  );

  // The heading names a ticker only for a contract in the factory's records.
  const heading = report ? (registered ? report.reading.token!.symbol : `Contract ${shortHash(address, 6, 4)}`) : (listed?.symbol ?? `Contract ${shortHash(address, 6, 4)}`);
  const subtitle = report ? (registered ? report.reading.token!.name : null) : (listed?.name ?? null);

  return (
    <article className={`${styles.page} ${styles.detail}`}>
      <Crumbs label={listed?.symbol ?? ticker ?? shortHash(address, 6, 4)} />
      <header className={styles.tokenHead}>
        <h1 className={heading.startsWith("Contract ") ? styles.contractTitle : undefined}>{heading}</h1>
        {subtitle && <p className={styles.tokenName}>{subtitle}</p>}
        <AddressRow address={address} />
      </header>
      {state.status === "loading" && <ReportSkeleton />}
      {state.status === "error" && (
        <Failure message="The chain could not be read just now. Its public endpoints are sometimes busy." onRetry={state.reload} />
      )}
      {report && <ReportView report={report} ticker={ticker} onReload={state.reload} />}
    </article>
  );
}

function AddressRow({ address }: { address: Address }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the address stays selectable.
    }
  };
  return (
    <div className={styles.addressRow}>
      <code className="mono">{address}</code>
      <button type="button" className={styles.copy} onClick={copy} aria-label="Copy the contract address">
        {copied ? "Copied" : "Copy"}
      </button>
      <a href={addressUrl(address)} target="_blank" rel="noreferrer">
        On the explorer
      </a>
      <span className="visually-hidden" role="status">
        {copied ? "Address copied" : ""}
      </span>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-label="Reading the contract from the chain…">
      {[0, 1, 2, 3].map((i) => (
        <div key={i}>
          <span className="skeleton" style={{ height: 13, width: 120 }} />
          <span className="skeleton" style={{ height: 30, width: `${70 - i * 10}%` }} />
          <span className="skeleton" style={{ height: 13, width: "88%" }} />
          <span className="skeleton" style={{ height: 13, width: "64%" }} />
        </div>
      ))}
    </div>
  );
}

function ReportView({ report, ticker, onReload }: { report: StockReport; ticker?: string; onReload: () => void }) {
  const { reading, verdict } = report;
  const token = reading.token;
  const registered = verdict.kind === "registered";
  return (
    <>
      <div className={styles.panels}>
        <VerdictPanel report={report} ticker={ticker} />
        {registered && token && report.multiplier && (
          <>
            <PricePanel report={report} />
            <MultiplierPanel report={report} />
            <MovementPanel report={report} />
            <HistoryPanel report={report} />
          </>
        )}
      </div>
      <footer className={styles.footer}>
        <p className={styles.measured}>
          {measuredLine(reading.blockNumber)} <span className={styles.fine}>Block time {formatUtc(reading.blockTime)}.</span>
        </p>
        <Provenance report={report} />
        <div className={styles.actions}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReload}>
            Read again
          </button>
          <div className={styles.links}>
            <a href={SOURCES.stockSource} target="_blank" rel="noreferrer">
              The Stock contract&apos;s source
            </a>
            <a href={SOURCES.erc8056} target="_blank" rel="noreferrer">
              ERC-8056
            </a>
            <a href={SOURCES.chainlinkRobinhood} target="_blank" rel="noreferrer">
              Chainlink on Robinhood tokens
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

function Provenance({ report }: { report: StockReport }) {
  const parts: ReactNode[] = [];
  if (report.feed?.kind === "read") {
    parts.push(
      <span key="feed">
        The price is the Chainlink feed&apos;s answer at the same block; Hyvo took the feed&apos;s address from Chainlink&apos;s reference data directory, fetched{" "}
        {report.directoryFetchedAt ? formatUtc(Math.floor(Date.parse(report.directoryFetchedAt) / 1000)) : "just now"}.
      </span>,
    );
  }
  if (report.verdict.kind === "registered") {
    parts.push(
      <span key="scan">
        {" "}
        The history comes from Hyvo&apos;s scan of the chain up to block {block(report.snapshot.block)} ({formatUtc(Math.floor(Date.parse(report.snapshot.time) / 1000))}).
      </span>,
    );
  }
  return parts.length ? <p className={styles.fine}>{parts}</p> : null;
}

// --- is this the token? ---------------------------------------------------------------------------

function VerdictPanel({ report, ticker }: { report: StockReport; ticker?: string }) {
  const { reading, verdict, listed } = report;
  const token = reading.token;
  const yes = verdict.kind === "registered";
  let title: string;
  let body: ReactNode;
  switch (verdict.kind) {
    case "registered":
      title = `Yes. The Stock Token factory records this contract as ${token!.symbol}.`;
      body = (
        <p>
          The factory deployed it and keeps it under its uid: asked for that uid, the factory answers with this address. A copy can take a ticker, a name and a
          uid, but not this record.
        </p>
      );
      break;
    case "recorded-elsewhere":
      title = "No. The factory records a different contract for this uid.";
      body = (
        <p>
          This contract carries the uid of a stock token{token ? ` and calls itself ${token.symbol}` : ""}, but asked for that uid, the factory answers with{" "}
          <Link to={`/stocks/${verdict.recorded}`} className="mono">
            {shortHash(verdict.recorded, 6, 4)}
          </Link>
          . That one is the token the factory deployed.
        </p>
      );
      break;
    case "unknown-uid":
      title = "No. The factory has no token for this contract's uid.";
      body = <p>It answers like a stock token{token ? ` and calls itself ${token.symbol}` : ""}, but the factory does not record it under its uid.</p>;
      break;
    case "not-a-stock-token":
      title = "No. This contract does not answer like a stock token.";
      body = <p>It has no uid, multiplier or pause flag to read, so it is not one of the tokens the factory deploys.</p>;
      break;
    case "no-code":
      title = "No contract is deployed at this address.";
      body = <p>Robinhood Chain has no code at this address at this block: it is an ordinary account, or nothing yet.</p>;
      break;
  }
  const renamed = yes && ticker && token && token.symbol !== ticker;
  return (
    <section className={`${styles.panel} ${styles.verdict} ${styles.wide}`} style={panel(0)} aria-labelledby="stock-verdict">
      <h2 id="stock-verdict">{yes ? `Is this the ${token!.symbol} stock token?` : "Is this a Robinhood stock token?"}</h2>
      <div className={styles.answer}>
        <span className={styles.seal} data-yes={yes} aria-hidden="true">
          {yes ? <CheckMark size={15} /> : "×"}
        </span>
        <div>
          <h3>{title}</h3>
          {body}
          {!yes && verdict.kind !== "no-code" && (
            <p className={styles.note}>That is all it says: the factory does not record this contract. It is not a judgment of what the contract does.</p>
          )}
          {renamed && (
            <p className={styles.note}>
              Hyvo&apos;s list had it as {ticker}; its ticker on-chain is now {token.symbol}.
            </p>
          )}
        </div>
      </div>
      {token && (
        <dl className={styles.facts}>
          <div>
            <dt>uid</dt>
            <dd>
              <code className="mono">{token.uid}</code>
              <small>The token&apos;s id, read from uid(). The factory&apos;s tokenAddress(uid) {yes ? "returns this contract" : "is the check above"}.</small>
            </dd>
          </div>
          <div>
            <dt>Name and ticker</dt>
            <dd>
              {token.name} · {token.symbol}
              <small>As the contract states them. Any contract can state these.</small>
            </dd>
          </div>
          {yes && (
            <div>
              <dt>Runs on</dt>
              <dd>
                <span>
                  The Stock contract{" "}
                  <a href={addressUrl(reading.implementation ?? STOCK_IMPLEMENTATION)} target="_blank" rel="noreferrer" className="mono">
                    {shortHash(reading.implementation ?? STOCK_IMPLEMENTATION, 4, 4)}
                  </a>
                  , behind the registry{" "}
                  <a href={addressUrl(STOCK_REGISTRY)} target="_blank" rel="noreferrer" className="mono">
                    {shortHash(STOCK_REGISTRY, 4, 4)}
                  </a>
                </span>
                <small>
                  {report.system.beaconIsRegistry ? "Its proxy's beacon is that registry, " : "Its proxy's beacon could not be read, "}
                  which holds every role, the pause switch and the blocklist. The source is{" "}
                  <a href={SOURCES.stockSource} target="_blank" rel="noreferrer">
                    verified on Sourcify
                  </a>
                  .
                </small>
              </dd>
            </div>
          )}
          {yes && (
            <div>
              <dt>Deployed</dt>
              <dd>
                {listed ? (
                  <>
                    <span>
                      <a href={txUrl(listed.deployed.tx)} target="_blank" rel="noreferrer">
                        {formatUtc(Math.floor(Date.parse(listed.deployed.time) / 1000))}
                      </a>
                      , block {block(listed.deployed.block)}, as {listed.deployed.symbol}
                    </span>
                    <small>
                      By the factory{" "}
                      <a href={addressUrl(STOCK_FACTORY)} target="_blank" rel="noreferrer" className="mono">
                        {shortHash(STOCK_FACTORY, 4, 4)}
                      </a>
                      , in its Deployed event.
                    </small>
                  </>
                ) : (
                  <span>After Hyvo&apos;s scan (block {block(report.snapshot.block)}), so its deployment is not in the list yet.</span>
                )}
              </dd>
            </div>
          )}
          {yes && token.terms && (
            <div>
              <dt>Terms it links</dt>
              <dd>
                {/* A link only when it is one: the text comes from the contract. */}
                {/^https:\/\/[^\s"<>]+$/.test(token.terms) ? (
                  <a href={token.terms} target="_blank" rel="noreferrer">
                    {token.terms}
                  </a>
                ) : (
                  <span>{token.terms}</span>
                )}
                <small>What the contract&apos;s terms() returns.</small>
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

// --- the price ------------------------------------------------------------------------------------------

function PricePanel({ report }: { report: StockReport }) {
  const token = report.reading.token!;
  const feed = report.feed;
  return (
    <section className={styles.panel} style={panel(1)} aria-labelledby="stock-price">
      <h2 id="stock-price">What its price is</h2>
      <PriceBody feed={feed} symbol={token.symbol} multiplier={report.multiplier!.value} now={report.reading.blockTime} />
    </section>
  );
}

const PER_SHARE_REASONS: Record<string, string> = {
  "oracle-paused": "Not worked out: the oracle is paused, so the feed holds a value from before the pause.",
  "multiplier-changed-since-update": "Not worked out: the multiplier changed after the feed's last update, so the two do not belong together.",
  "multiplier-timing-unknown": "Not worked out: a multiplier change is scheduled, and Hyvo cannot tell when the value in effect started.",
  "no-answer": "Not worked out: the feed has no valid answer.",
};

/** `now` is the block's time: ages are measured to the block the facts were read at. */
function PriceBody({ feed, symbol, multiplier, now }: { feed: FeedPart | null; symbol: string; multiplier: string; now: number }) {
  if (!feed) return <p>No price was read.</p>;
  switch (feed.kind) {
    case "none":
      return (
        <p>
          Chainlink&apos;s directory lists no tokenized-price feed for {symbol}, so there is no price on the chain to show. Hyvo does not take prices from anywhere
          else.
        </p>
      );
    case "several":
      return (
        <p>
          Chainlink&apos;s directory lists {feed.listings.length} feeds for {symbol} ({feed.listings.map((listing) => listing.name).join(", ")}). Hyvo does not choose
          between them.
        </p>
      );
    case "directory-failed":
      return <Failure message={`Chainlink's feed directory could not be read just now, so the feed's address is not known. ${feed.message}`} />;
    case "read-failed":
      return <Failure message={`The Chainlink feed ${shortHash(feed.listing.proxy, 4, 4)} could not be read just now.`} />;
    case "read":
      break;
  }
  const { listing, reading, price } = feed;
  return (
    <>
      {price.answered ? (
        <div className={styles.figure}>
          <p className={`${styles.big} ${styles.price} num`}>
            {groupThousands(roundDecimal(price.perToken, 2))}
            <small>USD per token</small>
          </p>
          <p className={`${styles.exact} mono`}>
            Answer {price.perToken} ({price.decimals} decimals)
          </p>
        </div>
      ) : (
        <p className={styles.note}>
          The feed answers {price.perToken}, which Chainlink says to treat as invalid. No price is shown.
        </p>
      )}
      <dl className={styles.facts}>
        <div>
          <dt>Updated</dt>
          <dd>
            <span>
              {relativeTime(price.updatedAt, now)}, {formatUtc(price.updatedAt)}
            </span>
            <small>
              {price.withinHeartbeat
                ? `Within the feed's ${formatSpan(listing.heartbeatSeconds)} heartbeat.`
                : `Older than the feed's ${formatSpan(listing.heartbeatSeconds)} heartbeat.`}{" "}
              {listing.deviationPercent !== null && `It also updates when the price moves ${listing.deviationPercent}%.`}
            </small>
          </dd>
        </div>
        <div>
          <dt>What it is</dt>
          <dd>
            <span>The price of one token: the underlying share&apos;s 24/5 market price × the multiplier ({multiplier}).</span>
            <small>
              Chainlink calls it the token&apos;s Total Return Value and reads the multiplier from the token&apos;s uiMultiplier().{" "}
              <a href={SOURCES.chainlinkRobinhood} target="_blank" rel="noreferrer">
                Chainlink&apos;s page
              </a>
            </small>
          </dd>
        </div>
        <div>
          <dt>Per underlying share</dt>
          <dd>
            {price.perShare.value !== null ? (
              <>
                <span className="num">{groupThousands(roundDecimal(price.perShare.value, 2))} USD</span>
                <small>The answer ÷ the multiplier: Chainlink&apos;s formula worked backwards, to {price.decimals} decimals: {price.perShare.value}.</small>
              </>
            ) : (
              <small>{PER_SHARE_REASONS[price.perShare.reason]}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Feed</dt>
          <dd>
            <span>
              {listing.name} ·{" "}
              <a href={addressUrl(listing.proxy)} target="_blank" rel="noreferrer" className="mono">
                {shortHash(listing.proxy, 4, 4)}
              </a>
            </span>
            <small>{reading.description ? `On-chain it describes itself as “${reading.description}”.` : "It does not describe itself on-chain."}</small>
          </dd>
        </div>
      </dl>
      <p className={styles.fine}>A reading of the feed at block {block(reading.blockNumber)}, not a quote to trade at and not a forecast.</p>
    </>
  );
}

// --- the multiplier ------------------------------------------------------------------------------------

function MultiplierPanel({ report }: { report: StockReport }) {
  const token = report.reading.token!;
  const multiplier = report.multiplier!;
  const now = report.reading.blockTime;
  const since = multiplier.inEffectSince;
  const scaled = token.totalSupplyUI;
  return (
    <section className={styles.panel} style={panel(2)} aria-labelledby="stock-multiplier">
      <h2 id="stock-multiplier">Multiplier</h2>
      <div className={styles.figure}>
        <p className={`${styles.big} num`}>{roundDecimal(multiplier.value, 6)}</p>
        <p className={`${styles.exact} mono`}>Exact: {multiplier.value}</p>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>In effect since</dt>
          <dd>
            {since === "deployment" ? (
              <span>Deployment: it has never changed.</span>
            ) : since === "unknown" ? (
              <span>Not known from the chain alone while a change is scheduled.</span>
            ) : (
              <span>{formatUtc(since)}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>
            {multiplier.scheduled ? (
              <>
                <span>
                  Becomes <b className="num">{multiplier.scheduled.value}</b> on {formatUtc(multiplier.scheduled.effectiveAt)} (
                  {relativeTime(multiplier.scheduled.effectiveAt, now)})
                </span>
                <small>Staged with updateMultiplier(value, effectiveAt): newUIMultiplier() and effectiveAt() hold it until then.</small>
              </>
            ) : (
              <span>No change is scheduled.</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Supply</dt>
          <dd>
            <span className="num">{groupThousands(roundDecimal(formatFixed(token.totalSupply, token.decimals), 4))} tokens</span>
            {scaled !== null && (
              <small>× the multiplier, {groupThousands(roundDecimal(formatFixed(scaled, token.decimals), 4))}: what totalSupplyUI() returns.</small>
            )}
          </dd>
        </div>
        <div>
          <dt>What it means</dt>
          <dd>
            <small>
              Balances are stored as they are, and a wallet that follows{" "}
              <a href={SOURCES.erc8056} target="_blank" rel="noreferrer">
                ERC-8056
              </a>{" "}
              shows them times this number. Chainlink&apos;s feed prices one token as the share&apos;s price times it, so it rises a little with a dividend
              reinvestment and jumps with a split.
            </small>
          </dd>
        </div>
      </dl>
    </section>
  );
}

// --- can it move ------------------------------------------------------------------------------------------

/** What oraclePaused() means for this token: Chainlink's feeds honor it, if a feed exists. */
function oracleLine(oracle: "publishing" | "held" | "unknown", hasFeed: boolean): string {
  if (oracle === "unknown") return "oraclePaused() could not be read.";
  if (oracle === "publishing") {
    return hasFeed
      ? "oraclePaused() is false, so Chainlink's feed for it keeps updating."
      : "oraclePaused() is false. Chainlink's feeds honor this flag; none is listed for this token.";
  }
  return hasFeed
    ? "oraclePaused() is true: Chainlink's feed holds its last value while a corporate action is applied."
    : "oraclePaused() is true: the flag Chainlink's feeds honor while a corporate action is applied. None is listed for this token.";
}

function MovementPanel({ report }: { report: StockReport }) {
  const movement = report.movement!;
  const token = report.reading.token!;
  const hasFeed = report.feed?.kind === "read" || report.feed?.kind === "read-failed";
  const session = usEquitySession(new Date(report.reading.blockTime * 1000));
  const pausedBy = [movement.tokenPaused ? "the token's own switch" : null, movement.registryPaused ? "the registry's switch, which pauses every token" : null].filter(Boolean);
  return (
    <section className={`${styles.panel} ${styles.wide}`} style={panel(3)} aria-labelledby="stock-movement">
      <h2 id="stock-movement">Can it move right now?</h2>
      <dl className={styles.facts}>
        <div>
          <dt>Transfers</dt>
          <dd>
            <span className={styles.state}>
              <span className={styles.dot} data-on={movement.transfers === "open"} aria-hidden="true" />
              {movement.transfers === "open" ? "Open" : "Paused"}
            </span>
            <small>
              {movement.transfers === "open"
                ? "paused() is false: transfers and approvals go through, except for accounts on the registry's blocklist."
                : `paused() is true${pausedBy.length ? `, set by ${pausedBy.join(" and ")}` : ""}: transfers, approvals, mints and burns revert until it is lifted.`}
            </small>
          </dd>
        </div>
        <div>
          <dt>Oracle pause</dt>
          <dd>
            <span className={styles.state}>
              <span className={styles.dot} data-on={movement.oracle === "publishing"} aria-hidden="true" />
              {movement.oracle === "publishing" ? "Not paused" : movement.oracle === "held" ? "Paused" : "Unknown"}
            </span>
            <small>{oracleLine(movement.oracle, hasFeed)}</small>
          </dd>
        </div>
        <div>
          <dt>US equity session</dt>
          <dd>
            <span>
              {session.weekday} {session.time} in New York: {SESSION_LABELS[session.session]}
            </span>
            <small>
              By the clock at this block, using Chainlink&apos;s session table; market holidays are not counted.{" "}
              {session.session === "weekend" ? "Chainlink's feed holds its last price until the overnight session opens on Sunday." : ""}
            </small>
          </dd>
        </div>
      </dl>
      <p className={styles.fine}>
        On-chain flags of {token.symbol} at block {block(report.reading.blockNumber)}. Where and when the token can be bought or sold off the chain is
        Robinhood&apos;s to say, and not read here.
      </p>
    </section>
  );
}

// --- the multiplier history --------------------------------------------------------------------------------

function HistoryPanel({ report }: { report: StockReport }) {
  const token = report.reading.token!;
  const listed = report.listed;
  const updates = listed?.multiplierUpdates ?? [];
  const last = updates[updates.length - 1];
  const changedAfterScan = listed
    ? last
      ? BigInt(last.newMultiplier) !== token.newUIMultiplier || BigInt(last.effectiveAt) !== token.effectiveAt
      : token.effectiveAt !== 0n
    : false;
  const rows = updates.map((update, index) => ({
    update,
    replaced: index + 1 < updates.length && Date.parse(updates[index + 1]!.time) / 1000 < update.effectiveAt,
  }));
  return (
    <section className={`${styles.panel} ${styles.wide}`} style={panel(4)} aria-labelledby="stock-history">
      <h2 id="stock-history">Multiplier changes</h2>
      {!listed ? (
        <p>Hyvo&apos;s scan, up to block {block(report.snapshot.block)}, does not hold this contract, so it has no history to show.</p>
      ) : updates.length === 0 ? (
        <p>None up to block {block(report.snapshot.block)}: the multiplier has been 1.0 since the token was deployed.</p>
      ) : (
        <ol className={styles.history} reversed>
          {[...rows].reverse().map(({ update, replaced }) => (
            <HistoryRow key={`${update.block}-${update.tx}`} update={update} replaced={replaced} now={report.reading.blockTime} />
          ))}
        </ol>
      )}
      {changedAfterScan && (
        <p className={styles.note}>
          The multiplier was updated after Hyvo&apos;s scan: the values above this list are read live, and this list ends at block {block(report.snapshot.block)}.
        </p>
      )}
      {listed && listed.metadataUpdates.length > 0 && (
        <p>
          Name and ticker set again:{" "}
          {listed.metadataUpdates.map((meta, index) => (
            <span key={meta.tx}>
              {index > 0 && "; "}
              <a href={txUrl(meta.tx)} target="_blank" rel="noreferrer">
                {formatUtc(Math.floor(Date.parse(meta.time) / 1000))}
              </a>{" "}
              to “{meta.name}” ({meta.symbol})
            </span>
          ))}
          .
        </p>
      )}
      <p className={styles.fine}>
        Each row is a UIMultiplierUpdated event. The chain records the numbers, not the reason; Chainlink&apos;s page lists the usual ones: a dividend reinvestment
        raises the multiplier a little, a 10:1 split takes it from 1.0 to 10.0.
      </p>
    </section>
  );
}

function HistoryRow({ update, replaced, now }: { update: MultiplierUpdate; replaced: boolean; now: number }) {
  const from = formatFixed(BigInt(update.oldMultiplier), 18);
  const to = formatFixed(BigInt(update.newMultiplier), 18);
  const ratio = multiplierRatio(BigInt(update.oldMultiplier), BigInt(update.newMultiplier));
  const sent = Math.floor(Date.parse(update.time) / 1000);
  return (
    <li>
      <span>
        <time dateTime={new Date(update.effectiveAt * 1000).toISOString()}>{formatUtc(update.effectiveAt)}</time>
        {update.effectiveAt > now && <span className={styles.tag}>Scheduled</span>}
        {replaced && <span className={styles.tag}>Replaced before it took effect</span>}
      </span>
      <span className={`${styles.move} num`}>
        <b className="mono">{from}</b> → <b className="mono">{to}</b> <span className={styles.sent}>(× {ratio})</span>
      </span>
      <a className={styles.sent} href={txUrl(update.tx)} target="_blank" rel="noreferrer">
        Sent {formatUtc(sent)}, block {block(update.block)}
      </a>
    </li>
  );
}
