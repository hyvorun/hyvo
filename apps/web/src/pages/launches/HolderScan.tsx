import { HOLDER_LABELS, formatPercent, formatTokens, shortAddress, type HolderRow, type LaunchDetail, type LaunchEvent } from "@hyvo/launches";
import { Link } from "react-router";
import { CountUp } from "../../components/motion-data/CountUp";
import { Reveal } from "../../components/Reveal";
import { addressUrl } from "../../lib/explorer";
import { BlockLink, Provenance } from "./parts";
import { graduatedCount, useCreator, useHolderScan } from "./use-creator";
import own from "./HolderScan.module.css";
import styles from "./Launches.module.css";

const percent = (share: number | null) => (share === null ? "Not read" : formatPercent(share));

/** "This wallet launched N tokens on Pons; M graduated.", linking to the creator's page. */
export function CreatorLine({ creator }: { creator: `0x${string}` }) {
  const state = useCreator(creator, 0, "count");
  const link = (
    <Link to={`/launches/creator/${creator}`} className="arrow-link" viewTransition>
      See the creator&apos;s launches
    </Link>
  );
  if (state.status === "loading") return <>Counting this wallet&apos;s launches…</>;
  if (state.status === "error" || !state.answer) return <>Its other launches could not be counted just now. {link}</>;
  const total = state.answer.launches.length;
  const graduated = graduatedCount(state.phases);
  return (
    <>
      This wallet launched <b className="num">{total}</b> {total === 1 ? "token" : "tokens"} on Pons
      {state.chain === "ready" ? (
        <>
          ; <b className="num">{graduated}</b> graduated.
        </>
      ) : (
        "."
      )}{" "}
      {link}
    </>
  );
}

/** The holder scan of one launch, each figure with the block or the time it was read at. */
export function HolderScanSection({ detail, event, attempt }: { detail: LaunchDetail; event: LaunchEvent | null | undefined; attempt: number }) {
  const state = useHolderScan(detail, event, attempt);
  const scan = state.scan;
  return (
    <section className={styles.section} aria-labelledby="holders-title">
      <div className={styles.sectionHead}>
        <h2 id="holders-title">Holders</h2>
      </div>
      {(state.status === "waiting" || state.status === "loading") && (
        <p className={styles.note} role="status">
          Reading its holders…
        </p>
      )}
      {state.status === "error" && <p className={styles.note}>{state.error} Read the launch again to try once more.</p>}
      {state.status === "ready" && scan && state.read && (
        <>
          <ul className={styles.stats} aria-label="Holder figures">
            <HolderCount counted={scan.holderCount} listed={scan.rows.filter((row) => row.balance > 0n).length} />
            <li>
              <b className="num">{scan.top10 ? percent(scan.top10.share) : "Not read"}</b>
              <span>Held by the ten largest holders, leaving out the curve, the pool and burn addresses</span>
            </li>
            <li>
              <b className="num">{percent(scan.creator.share)}</b>
              <span>Held by the creator&apos;s wallet</span>
            </li>
            <li>
              <b className="num">{scan.firstSecond ? percent(scan.firstSecond.share) : "Not read"}</b>
              <span>
                {scan.firstSecond
                  ? `Held now by the ${scan.firstSecond.wallets} ${scan.firstSecond.wallets === 1 ? "wallet" : "wallets"} that bought in the launch second${scan.firstSecond.includesCreator ? ", the creator among them" : ""}${scan.firstSecond.unread > 0 ? `; ${scan.firstSecond.unread} of their balances not read` : ""}`
                  : "Held now by the wallets that bought in the launch second"}
              </span>
            </li>
          </ul>
          <p className={styles.fine}>
            Shares are of the total supply, and every balance was read on-chain at block <BlockLink block={state.read.block} />.{" "}
            {state.listSource ? `Who the largest holders are comes from ${state.listSource}.` : `${state.listMissing ?? "Blockscout's index was not read"}.`}{" "}
            {state.second ? (
              <>
                The launch second is blocks <BlockLink block={state.second.fromBlock} /> to <BlockLink block={state.second.toBlock} />, from the curve&apos;s CurveBuy events.
              </>
            ) : (
              state.secondMissing
            )}
          </p>
          {scan.rows.length > 0 ? (
            <Reveal as="ol" className={`${own.holders} stagger`} aria-label="Largest holders">
              {scan.rows.map((row, i) => (
                <HolderItem key={row.address} row={row} rank={i + 1} />
              ))}
            </Reveal>
          ) : (
            <p className={styles.note}>No list of the largest holders to show: {state.listMissing ?? "Blockscout's index lists none yet"}.</p>
          )}
          <Provenance reads={[state.read]} served={[]} />
        </>
      )}
    </section>
  );
}

function HolderItem({ row, rank }: { row: HolderRow; rank: number }) {
  return (
    <li>
      <span className={`${own.rank} num`}>{rank}</span>
      <a className="mono" href={addressUrl(row.address)} target="_blank" rel="noreferrer" title={row.address}>
        {shortAddress(row.address, 6, 4)}
      </a>
      <span className={own.labels}>
        {row.labels.map((label) => (
          <span key={label} className={own.label}>
            {HOLDER_LABELS[label]}
          </span>
        ))}
      </span>
      <span className={`${own.share} num`} title={`${formatTokens(row.balance)} tokens`}>
        {percent(row.share)}
      </span>
    </li>
  );
}

/**
 * Blockscout's holder count lags a new token: it can read 0 while the wallets listed below already hold it.
 * Then the page says "at least" the listed wallets instead of a count that contradicts the list.
 */
function HolderCount({ counted, listed }: { counted: number | null; listed: number }) {
  const behind = counted !== null && counted < listed;
  return (
    <li>
      <b className="num">
        {counted === null ? "Not read" : behind ? `${listed}+` : <CountUp value={counted} format={(n) => Math.round(n).toLocaleString("en-US")} />}
      </b>
      <span>{behind ? "Holders at least: Blockscout’s count has not caught up with this token yet" : "Holders, in Blockscout’s index"}</span>
    </li>
  );
}
