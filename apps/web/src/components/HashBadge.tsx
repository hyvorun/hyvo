import type { RunV1 } from "@hyvo/schema";
import { useEffect, useState } from "react";
import { shortHash } from "../lib/format";
import { hashInBackground } from "../lib/hash-run";
import styles from "./HashBadge.module.css";
import { CheckMark } from "./Icons";

type Check = "checking" | "verified" | "mismatch";

/** Re-hashes the run.json in the browser (RFC 8785 + keccak256) and compares it with `run.hash`.
 * The on-chain commit is checked on /oracle once commits exist. */
export function HashBadge({ run }: { run: RunV1 }) {
  const [check, setCheck] = useState<Check>("checking");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    setCheck("checking");
    void hashInBackground(run).then((hash) => {
      if (current) setCheck(hash === run.hash ? "verified" : "mismatch");
    });
    return () => {
      current = false;
    };
  }, [run]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(run.hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the full hash stays in the title.
    }
  };

  return (
    <div className={`${styles.badge} ${styles[check]}`} title={run.hash}>
      <span className={styles.seal} aria-hidden="true">
        {check === "verified" ? <CheckMark size={13} /> : check === "mismatch" ? "×" : ""}
      </span>
      <span className={styles.state}>
        {check === "checking" ? "Checking hash…" : check === "verified" ? "Hash verified in your browser" : "Hash does not match"}
      </span>
      <button type="button" className={`${styles.hash} mono`} onClick={copy} aria-label="Copy the run hash">
        {copied ? "copied" : shortHash(run.hash, 8, 6)}
      </button>
    </div>
  );
}
