import styles from "./States.module.css";

/**
 * `page` holds a whole page's place while it loads: at least a screen tall, so the footer starts below
 * the fold and does not jump when the content arrives.
 */
export function Loading({ label, page = false }: { label: string; page?: boolean }) {
  return (
    <div className={page ? `${styles.loading} ${styles.page}` : styles.loading} role="status">
      <span className={styles.dots} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}
    </div>
  );
}

export function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.failure} role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** The gallery's shape while it loads, so the page does not jump. */
export function RunListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className={styles.skeletons} role="status" aria-label="Loading runs…">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.skeletonRow}>
          <span className="skeleton" style={{ height: 14, width: `${70 - i * 12}%` }} />
          <span className="skeleton" style={{ height: 14, width: 96 }} />
        </div>
      ))}
    </div>
  );
}
