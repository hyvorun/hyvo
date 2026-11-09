import styles from "./motion.module.css";

/** What a copy button says once it has copied: a check that pops and draws, then the words. */
export function Copied({ children }: { children: string }) {
  return (
    <span className={styles.copied}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M3 8.6 6.4 12 13 4.6" pathLength={1} />
      </svg>
      {children}
    </span>
  );
}
