/** Save a launch to the watchlist, or take it off: kept in this browser, and with a HYVO holder's account. */
import { WATCHLIST_MAX } from "@hyvo/schema";
import { useState } from "react";
import { useHolderStatus } from "../../lib/holder-status";
import { addTo, removeFrom } from "../../lib/saved-lists";
import { useSavedList } from "../../lib/use-saved-list";
import styles from "./Utility.module.css";

export function WatchButton({ token, symbol }: { token: `0x${string}`; symbol: string | null }) {
  const holder = useHolderStatus();
  const saved = useSavedList("watchlist", holder);
  const [note, setNote] = useState<string | null>(null);
  const watching = saved.list.includes(token.toLowerCase() as `0x${string}`);
  const label = symbol ?? "this launch";

  const toggle = () => {
    if (watching) {
      saved.set(removeFrom(saved.list, token));
      setNote(`${label} is off your watchlist.`);
      return;
    }
    const next = addTo(saved.list, token, WATCHLIST_MAX);
    if (next.result === "full") return setNote(`Your watchlist holds ${WATCHLIST_MAX} launches. Take one off first.`);
    saved.set(next.list);
    setNote(`${label} is on your watchlist.`);
  };

  return (
    <>
      <button type="button" className={styles.watch} aria-pressed={watching} onClick={toggle}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.6l1.9 4.1 4.5.5-3.3 3 .9 4.4L8 11.4l-4 2.2.9-4.4-3.3-3 4.5-.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        {watching ? "On your watchlist" : "Add to watchlist"}
      </button>
      <span role="status" className="visually-hidden">
        {note ?? ""}
      </span>
    </>
  );
}
