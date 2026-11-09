import type { OracleView } from "@hyvo/schema";
import { Link } from "react-router";
import { txUrl } from "../lib/explorer";
import { shortHash } from "../lib/format";
import styles from "./HashBadge.module.css";
import { CheckMark } from "./Icons";
import { Decode } from "./motion-data/Decode";

/** The run's oracle commit: confirmed on Robinhood Chain (with its transaction), or on its way. */
export function OracleBadge({ runId, oracle }: { runId: string; oracle: OracleView | null }) {
  if (!oracle) return null;
  const confirmed = oracle.status === "confirmed";
  return (
    <div className={`${styles.badge} ${confirmed ? styles.verified : styles.checking}`}>
      <span className={styles.seal} aria-hidden="true">
        {confirmed && <CheckMark size={13} />}
      </span>
      <span className={styles.state}>
        {confirmed ? "Hash committed on Robinhood Chain" : oracle.status === "failed" ? "On-chain commit is being retried" : "On-chain commit pending"}
      </span>
      {oracle.txHash && (
        <a className={`${styles.hash} mono`} href={txUrl(oracle.txHash)} target="_blank" rel="noreferrer" title={oracle.txHash}>
          <Decode text={shortHash(oracle.txHash, 6, 4)} />
        </a>
      )}
      {confirmed && (
        <Link className={styles.hash} to={`/oracle?run=${runId}`}>
          Verify
        </Link>
      )}
    </div>
  );
}
