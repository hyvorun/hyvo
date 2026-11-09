import {
  distinctName,
  formatAmount,
  formatBps,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUtc,
  phaseExplained,
  phaseLabel,
  progress,
  shortAddress,
  type LaunchDetail,
  type Trade,
} from "@hyvo/launches";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Arrow } from "../../components/Icons";
import { CountUp } from "../../components/motion-data/CountUp";
import { Decode } from "../../components/motion-data/Decode";
import { Reveal } from "../../components/Reveal";
import { Failure } from "../../components/States";
import { addressUrl, tokenUrl, txUrl } from "../../lib/explorer";
import { tokenFromPath } from "../../lib/launches";
import { useDescription, useTitle } from "../../lib/use-title";
import { Age, Amount, BlockLink, pairLabel, Provenance, Towards } from "./parts";
import { useLaunch, type LaunchState } from "./use-launches";
import styles from "./Launches.module.css";

/** One Pons launch: the factory's record and its curve, read at one block, and its last hour of trades. */
export function LaunchPage() {
  const params = useParams();
  const token = tokenFromPath(params.token);
  const [attempt, setAttempt] = useState(0);
  const state = useLaunch(token, attempt);
  const detail = state.lookup?.kind === "v2" ? state.lookup.detail : null;
  const symbol = state.lookup && state.lookup.kind !== "none" ? (state.lookup.kind === "v2" ? state.lookup.detail.symbol : state.lookup.symbol) : null;
  useTitle(symbol ? `${symbol} · Launches` : "Launch");
  useDescription(
    symbol
      ? `${symbol} on Pons, read from Robinhood Chain: pair asset, phase, creator tax, liquidity and its last hour of trades. Not a trading signal.`
      : "One Pons launch on Robinhood Chain, read from the chain. Not a trading signal.",
  );

  return (
    <article className={styles.page}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/launches" viewTransition>
          Launches
        </Link>
        <span aria-hidden="true">/</span>
        <span className="mono">{symbol ?? (token ? shortAddress(token, 6, 4) : "Not an address")}</span>
      </nav>

      {!token && <NotAddress value={params.token ?? ""} />}
      {token && state.status === "loading" && (
        <div className={styles.head}>
          <h1>Reading the launch…</h1>
          <p className={styles.provenance} role="status">
            Reading Robinhood Chain…
          </p>
        </div>
      )}
      {token && state.status === "error" && (
        <>
          <div className={styles.head}>
            <h1 className="mono">{shortAddress(token, 6, 4)}</h1>
          </div>
          <Failure message={state.error ?? "The chain could not be read just now."} onRetry={() => setAttempt((n) => n + 1)} />
        </>
      )}
      {token && state.status === "ready" && state.lookup?.kind === "none" && <NotPons token={token} symbol={state.lookup.symbol} state={state} />}
      {token && state.status === "ready" && state.lookup?.kind === "v1" && <PonsV1 state={state} />}
      {detail && <Detail detail={detail} state={state} onAgain={() => setAttempt((n) => n + 1)} />}
    </article>
  );
}

function Detail({ detail, state, onAgain }: { detail: LaunchDetail; state: LaunchState; onAgain: () => void }) {
  const name = distinctName(detail.name, detail.symbol);
  const share = progress(detail.liquidity, detail.graduationThreshold);
  const graduated = detail.phase === "graduated" || detail.graduated === true;
  const now = detail.read.timestamp;
  const pair = pairLabel(detail.pair);
  return (
    <>
      <header className={styles.head}>
        <p className={styles.eyebrow}>Pons V2 launch</p>
        <h1 className={styles.symbol}>{detail.symbol ?? shortAddress(detail.token)}</h1>
        {name && <p className={styles.name}>{name}</p>}
        <ul className={styles.tags} aria-label="Summary">
          <li>Paired with {pair}</li>
          <li>{phaseLabel(detail.phase, detail.graduated)}</li>
          <li>Creator tax {formatBps(detail.creatorTaxBps)}</li>
          <li>
            Launched <Age at={detail.launchedAt} now={now} /> ago
          </li>
        </ul>
        <div className={styles.status}>
          <Provenance reads={[detail.read]} served={state.served}>
            {" "}
            <button type="button" className={styles.again} onClick={onAgain}>
              Read again
            </button>
          </Provenance>
        </div>
      </header>

      <section className={styles.progressPanel} aria-labelledby="progress-title">
        <h2 id="progress-title" className="visually-hidden">
          Towards graduation
        </h2>
        {graduated ? (
          <p>
            <b>Graduated.</b> {phaseExplained("graduated")}
          </p>
        ) : (
          <>
            <p>
              <b className="num">{share === null ? "Not read" : formatPercent(share)}</b> of the way to graduation: its curve holds{" "}
              <Amount value={detail.liquidity} asset={detail.pair} /> of the <Amount value={detail.graduationThreshold} asset={detail.pair} /> it graduates at.
            </p>
            <span className={styles.bigBar} aria-hidden="true">
              <span style={{ width: `${share === null ? 0 : Math.max(share * 100, share > 0 ? 0.8 : 0)}%` }} />
            </span>
          </>
        )}
      </section>

      <div className={styles.detailGrid}>
        <section className={styles.section} aria-labelledby="facts-title">
          <h2 id="facts-title">On-chain facts</h2>
          <dl className={styles.ledger}>
            <Fact label="Token" value={<AddressValue address={detail.token} href={tokenUrl(detail.token)} />} />
            <Fact label="Creator" value={<AddressValue address={detail.creator} href={addressUrl(detail.creator)} />} note="The address Pons records as the launch's deployer." />
            {detail.feeRecipient.toLowerCase() !== detail.creator.toLowerCase() && (
              <Fact label="Creator fees go to" value={<AddressValue address={detail.feeRecipient} href={addressUrl(detail.feeRecipient)} />} />
            )}
            <Fact
              label="Pair asset"
              value={
                detail.pair.address === "0x0000000000000000000000000000000000000000" ? (
                  <span>ETH, the chain&apos;s own currency</span>
                ) : (
                  <span>
                    {pair}
                    {detail.pair.name && detail.pair.name !== detail.pair.symbol ? <span className={styles.muted}> {detail.pair.name}</span> : null}{" "}
                    <a className="mono" href={tokenUrl(detail.pair.address)} target="_blank" rel="noreferrer">
                      {shortAddress(detail.pair.address)}
                    </a>
                  </span>
                )
              }
              note="Every buy and sell on its curve, and its pool after graduation, is in this asset."
            />
            <Fact label="Phase" value={phaseLabel(detail.phase, detail.graduated)} note={phaseExplained(detail.phase)} />
            <Fact label="Bonding curve" value={<AddressValue address={detail.curve} href={addressUrl(detail.curve)} />} />
            <Fact label="Trading fee" value={detail.feeBps === null ? "Not read" : formatBps(detail.feeBps)} note="Taken from every curve trade and split between Pons, the creator and any buyback." />
            <Fact label="Creator tax" value={formatBps(detail.creatorTaxBps)} note="Set at launch and fixed: charged on every curve trade on top of the fee, and paid to the creator in full." />
            <Fact label="Buyback" value={detail.buybackEnabled ? "On" : "Off"} note="When on, a share of the fees buys the token back and locks it." />
            {detail.snipeTaxStartBps !== null && detail.snipeTaxSeconds !== null && (
              <Fact
                label="Launch-second tax"
                value={detail.snipeTaxStartBps === 0 ? "None" : `${formatBps(detail.snipeTaxStartBps)}, gone after ${formatDuration(detail.snipeTaxSeconds)}`}
                note="A tax on buys in the first seconds after launch, falling to zero. Wallets the creator named at launch are exempt."
              />
            )}
            {detail.supply !== null && <Fact label="Supply" value={<span className="num">{formatTokens(detail.supply)}</span>} />}
            {detail.reserved !== null && <Fact label="Kept for the pool" value={<span className="num">{formatTokens(detail.reserved)}</span>} note="The curve never sells below this; it seeds the Uniswap V4 pool at graduation." />}
            {!graduated && detail.sellable !== null && <Fact label="Left to buy on the curve" value={<span className="num">{formatTokens(detail.sellable)}</span>} />}
            <Fact label="Launched" value={detail.launchedAt ? <time dateTime={new Date(detail.launchedAt * 1000).toISOString()}>{formatUtc(detail.launchedAt)}</time> : "Not read"} note={<LaunchTx state={state} />} />
          </dl>
        </section>
        <Trades detail={detail} state={state} />
      </div>

      <div className={styles.actions}>
        <Link to={`/check/${detail.token}`} className="btn btn-primary" viewTransition>
          Check this token with Hyvo Check <Arrow />
        </Link>
        <a className="arrow-link" href={tokenUrl(detail.token)} target="_blank" rel="noreferrer">
          Open it on the block explorer <Arrow />
        </a>
      </div>
      <p className={styles.fine}>
        Hyvo Launches is not affiliated with this token, its creator or Pons. The facts above are what the chain&apos;s contracts hold; they say nothing about where its price goes.
      </p>
    </>
  );
}

function Trades({ detail, state }: { detail: LaunchDetail; state: LaunchState }) {
  const { trades } = state;
  const pair = pairLabel(detail.pair);
  const recent = [...trades.list].reverse().slice(0, 10);
  return (
    <section className={styles.section} aria-labelledby="trades-title">
      <h2 id="trades-title">The last hour on its curve</h2>
      {trades.status === "loading" && <p className={styles.note}>Counting its trades…</p>}
      {trades.status === "error" && <p className={styles.note}>Its trades could not be read just now.</p>}
      {trades.status === "ready" && (
        <>
          {trades.summary ? (
            <dl className={styles.ledger}>
              <Fact label="Trades" value={<span className="num"><CountUp value={trades.summary.trades} format={String} /></span>} note={`${trades.summary.buys} buys and ${trades.summary.sells} sells.`} />
              <Fact label="Traders" value={<span className="num"><CountUp value={trades.summary.traders} format={String} /></span>} note="Different addresses that received the tokens or the pair asset." />
              <Fact label="Traded" value={<Amount value={trades.summary.volume} asset={detail.pair} />} note="Before fee and tax." />
              {trades.summary.tax > 0n && <Fact label="Creator tax paid" value={<Amount value={trades.summary.tax} asset={detail.pair} />} />}
            </dl>
          ) : (
            <p className={styles.note}>{detail.phase === "graduated" ? "Its curve no longer trades: it graduated." : "No trade on its curve in this hour."}</p>
          )}
          {recent.length > 0 && (
            <>
              <h3 className={styles.subhead}>Latest trades</h3>
              <Reveal as="ol" className={`${styles.trades} stagger`}>
                {recent.map((trade) => (
                  <TradeRow key={`${trade.txHash}:${trade.logIndex}`} trade={trade} pair={pair} decimals={detail.pair.decimals} now={detail.read.timestamp} />
                ))}
              </Reveal>
            </>
          )}
          {trades.fromBlock !== null && trades.toBlock !== null && (
            <p className={styles.fine}>
              Blocks <BlockLink block={trades.fromBlock} /> to <BlockLink block={trades.toBlock} />, from the curve&apos;s CurveBuy and CurveSell events.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function TradeRow({ trade, pair, decimals, now }: { trade: Trade; pair: string; decimals: number; now: number }) {
  return (
    <li data-side={trade.side}>
      <span className={trade.side === "buy" ? styles.buys : styles.sells}>
        <i aria-hidden="true" />
        {trade.side === "buy" ? "Buy" : "Sell"}
      </span>
      <span className="num">
        {formatAmount(trade.quote, decimals)} {pair}
      </span>
      <span className="mono" title={trade.trader}>
        <span className="visually-hidden">Trader </span>
        <Decode text={shortAddress(trade.trader)} />
      </span>
      <a className={styles.when} href={txUrl(trade.txHash)} target="_blank" rel="noreferrer" title={`Transaction ${trade.txHash}`}>
        {trade.timestamp ? (
          <>
            <Age at={trade.timestamp} now={now} /> ago
          </>
        ) : (
          <>block {trade.block.toLocaleString("en-US")}</>
        )}
      </a>
    </li>
  );
}

function LaunchTx({ state }: { state: LaunchState }) {
  if (state.event.status === "loading") return <>Looking for its launch transaction…</>;
  const event = state.event.data;
  if (!event) return <>Its launch transaction was not found near that time.</>;
  return (
    <>
      In block <BlockLink block={event.block} />,{" "}
      <a className="mono" href={txUrl(event.txHash)} target="_blank" rel="noreferrer">
        transaction {shortAddress(event.txHash, 6, 4)}
      </a>
      .
    </>
  );
}

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={styles.value}>{value}</span>
        {note && <span className={styles.factNote}>{note}</span>}
      </dd>
    </div>
  );
}

function AddressValue({ address, href }: { address: string; href: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={styles.address}>
      <a className="mono" href={href} target="_blank" rel="noreferrer" title={address}>
        <span className={styles.wide}>
          <Decode text={address} duration={900} />
        </span>
        <span className={styles.narrow}>
          <Decode text={shortAddress(address, 6, 4)} />
        </span>
      </a>
      <button
        type="button"
        className={styles.copy}
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => undefined,
          );
        }}
        aria-label={`Copy ${address}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function NotAddress({ value }: { value: string }) {
  return (
    <div className={styles.head}>
      <h1>That is not a token address</h1>
      <p className={styles.lead}>
        A token address is 0x followed by 40 hexadecimal characters. <span className="mono">{value.slice(0, 48)}</span> is not one.
      </p>
      <p>
        <Link to="/launches" className="arrow-link" viewTransition>
          See the newest launches <Arrow />
        </Link>
      </p>
    </div>
  );
}

function NotPons({ token, symbol, state }: { token: `0x${string}`; symbol: string | null; state: LaunchState }) {
  const read = state.lookup?.kind === "none" ? state.lookup.read : null;
  return (
    <div className={styles.head}>
      <h1>{symbol ? `${symbol} is not a Pons V2 launch` : "No Pons V2 launch at this address"}</h1>
      <p className={styles.lead}>
        The Pons V2 launch factory has no record of <span className="mono">{token}</span>, and neither does the current Pons V1 factory. It may be a token from
        somewhere else, or not a token at all.
      </p>
      {read && <Provenance reads={[read]} served={state.served} />}
      <div className={styles.actions}>
        <Link to={`/check/${token}`} className="btn btn-ghost" viewTransition>
          Check this address with Hyvo Check <Arrow />
        </Link>
        <a className="arrow-link" href={addressUrl(token)} target="_blank" rel="noreferrer">
          Open it on the block explorer <Arrow />
        </a>
      </div>
    </div>
  );
}

function PonsV1({ state }: { state: LaunchState }) {
  if (state.lookup?.kind !== "v1") return null;
  const v1 = state.lookup;
  return (
    <div className={styles.head}>
      <p className={styles.eyebrow}>Pons V1 launch</p>
      <h1 className={styles.symbol}>{v1.symbol ?? shortAddress(v1.token)}</h1>
      {distinctName(v1.name, v1.symbol) && <p className={styles.name}>{v1.name}</p>}
      <p className={styles.lead}>
        This token launched through Pons V1, which has no bonding curve: each token starts in a Uniswap V3 pool against {v1.paired ? pairLabel(v1.paired) : "its pair asset"}, at a{" "}
        {formatBps(v1.poolFee / 100)} fee. Hyvo Launches reads the facts of Pons V2 launches.
      </p>
      <Provenance reads={[v1.read]} served={state.served} />
      <dl className={styles.ledger}>
        <Fact label="Token" value={<AddressValue address={v1.token} href={tokenUrl(v1.token)} />} />
        <Fact label="Creator" value={<AddressValue address={v1.creator} href={addressUrl(v1.creator)} />} />
        <Fact label="Supply" value={<span className="num">{formatTokens(v1.supply)}</span>} />
      </dl>
      <div className={styles.actions}>
        <Link to={`/check/${v1.token}`} className="btn btn-ghost" viewTransition>
          Check this token with Hyvo Check <Arrow />
        </Link>
      </div>
    </div>
  );
}
