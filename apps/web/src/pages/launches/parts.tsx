/** Pieces the launches pages share: where the facts were read, amounts, ages and the graduation bar. */
import { formatAmount, formatBlock, formatClock, formatDuration, formatPercent, formatUtc, progress, type Asset, type Snapshot } from "@hyvo/launches";
import { blockUrl } from "../../lib/explorer";
import styles from "./Launches.module.css";

/** "Measured on-chain at block N … Not a trading signal.", with the endpoints that answered. */
export function Provenance({ reads, served, children }: { reads: readonly Snapshot[]; served: readonly string[]; children?: React.ReactNode }) {
  const blocks = reads.filter((read) => read.block > 0n);
  if (blocks.length === 0) return null;
  const first = blocks.reduce((a, b) => (b.block < a.block ? b : a));
  const last = blocks.reduce((a, b) => (b.block > a.block ? b : a));
  return (
    <p className={styles.provenance}>
      {first.block === last.block ? (
        <>
          Measured on-chain at block <BlockLink block={first.block} />, {formatClock(first.timestamp)}.
        </>
      ) : (
        <>
          Measured on-chain at blocks <BlockLink block={first.block} /> to <BlockLink block={last.block} />, {formatClock(first.timestamp)} to {formatClock(last.timestamp)}.
        </>
      )}{" "}
      <strong>Not a trading signal.</strong>
      {served.length > 0 && <span className={styles.served}> Read in your browser through {served.join(", ")}.</span>}
      {children}
    </p>
  );
}

export function BlockLink({ block }: { block: bigint }) {
  return (
    <a className="num" href={blockUrl(Number(block))} target="_blank" rel="noreferrer">
      {formatBlock(block)}
    </a>
  );
}

/** An amount of a pair asset: "0.0599 ETH". */
export function Amount({ value, asset }: { value: bigint | null; asset: Asset }) {
  if (value === null) return <span className={styles.unknown}>Not read</span>;
  return (
    <span className="num">
      {formatAmount(value, asset.decimals)} <span className={styles.unit}>{asset.symbol ?? "units"}</span>
    </span>
  );
}

/** How long ago, with the exact time for hover and screen readers. */
export function Age({ at, now }: { at: number | null; now: number }) {
  if (at === null) return <span className={styles.unknown}>Unknown</span>;
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={formatUtc(at)} className="num">
      {formatDuration(now - at)}
    </time>
  );
}

/** How far a curve is towards graduation: a thin bar and the percentage. */
export function Towards({ liquidity, threshold, graduated }: { liquidity: bigint | null; threshold: bigint; graduated: boolean | null }) {
  if (graduated) return <span className={styles.graduated}>Graduated</span>;
  const share = progress(liquidity, threshold);
  if (share === null) return <span className={styles.unknown}>Not read</span>;
  return (
    <span className={styles.towards}>
      <span className={styles.bar} aria-hidden="true">
        <span style={{ width: `${Math.max(share * 100, share > 0 ? 1.5 : 0)}%` }} />
      </span>
      <span className="num">{formatPercent(share)}</span>
    </span>
  );
}

export function pairLabel(asset: Asset): string {
  return asset.symbol ?? `${asset.address.slice(0, 6)}…`;
}
