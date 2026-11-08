import type { RunSummary } from "@hyvo/schema";
import { useEffect, useState } from "react";
import { Disclaimer } from "../components/Disclaimer";
import { RunList } from "../components/RunList";
import { Failure, RunListSkeleton } from "../components/States";
import { fetchRuns } from "../lib/api";
import { useTitle } from "../lib/use-title";
import styles from "./pages.module.css";

export function RunsPage() {
  useTitle("Published runs");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "more" | "error">("loading");
  const [error, setError] = useState("");

  const load = async (after: string | null) => {
    setState(after ? "more" : "loading");
    try {
      const page = await fetchRuns(after);
      setRuns((current) => (after ? [...current, ...page.runs] : page.runs));
      setCursor(page.nextCursor);
      setState("ready");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setState("error");
    }
  };

  useEffect(() => {
    void load(null);
  }, []);

  return (
    <section className={styles.runs}>
      <header className={styles.pageHead}>
        <h1>Published runs</h1>
        <p>Every run here was hashed when it was published. Open one to replay its trades and posts.</p>
        <Disclaimer />
      </header>
      {state === "loading" && <RunListSkeleton />}
      {state === "error" && <Failure message={error} onRetry={() => void load(runs.length ? cursor : null)} />}
      {(state === "ready" || state === "more" || (state === "error" && runs.length > 0)) && <RunList runs={runs} />}
      {cursor && state !== "error" && (
        <button type="button" className={`btn btn-ghost ${styles.more}`} onClick={() => void load(cursor)} disabled={state === "more"}>
          {state === "more" ? "Loading…" : "Load more runs"}
        </button>
      )}
    </section>
  );
}
