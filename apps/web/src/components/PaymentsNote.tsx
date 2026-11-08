import { fetchHealth } from "../lib/api";
import { useAsync } from "../lib/use-async";

/** Said before someone fills in a form that needs a balance: until payments open, nothing paid can start. */
export function PaymentsNote({ className }: { className?: string | undefined }) {
  const health = useAsync(fetchHealth, "health");
  if (health.status !== "ready" || health.data.features.payments) return null;
  return (
    <p className={className} role="status">
      Paid runs are not open yet, so this cannot start at the moment. Every published run can still be replayed, and its hash checked.
    </p>
  );
}
