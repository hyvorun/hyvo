/**
 * The watchlist: launches a visitor saved from their pages, each read from the chain now in the visitor's browser
 * (packages/launches), at one block. Kept in this browser for everyone, and with a HYVO holder's account.
 */
import { distinctName, formatBps, phaseLabel, readWatchlist, shortAddress, type Snapshot, type WatchItem } from "@hyvo/launches";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Arrow } from "../../components/Icons";
import { Failure } from "../../components/States";
import { useHolderStatus } from "../../lib/holder-status";
import { assetCache, launchesReader } from "../../lib/launches";
import { removeFrom } from "../../lib/saved-lists";
import { useSavedList } from "../../lib/use-saved-list";
import { useDescription, useTitle } from "../../lib/use-title";
import { HolderSync } from "./HolderSync";
import { Amount, pairLabel, Provenance, Towards } from "./parts";
import launches from "./Launches.module.css";
import styles from "./Utility.module.css";

type Read = { status: "idle" | "loading" | "ready" | "error"; items: WatchItem[]; read: Snapshot | null; served: string[]; error: string | null };

export function WatchlistPage() {
  useTitle("Watchlist");
  useDescription("Pons launches you saved, read from Robinhood Chain in your browser at one block. Not a trading signal.");
  const holder = useHolderStatus();
  const saved = useSavedList("watchlist", holder);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Read>({ status: "idle", items: [], read: null, served: [], error: null });
  const key = saved.list.join(",");

  useEffect(() => {
    const tokens = key ? (key.split(",") as `0x${string}`[]) : [];
    if (tokens.length === 0) {
      setState({ status: "ready", items: [], read: null, served: [], error: null });
      return;
    }
    let live = true;
    setState((current) => ({ ...current, status: "loading", error: null }));
    const reader = launchesReader();
    readWatchlist(reader, tokens, assetCache).then(
      ({ items, read }) => live && setState({ status: "ready", items, read, served: [...reader.served], error: null }),
      () => live && setState((current) => ({ ...current, status: "error", error: "The chain could not be read just now. Try again in a moment." })),
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const count = saved.list.length;
  return (
    <article className={launches.page}>
      <nav className={launches.crumbs} aria-label="Breadcrumb">
        <Link to="/launches" viewTransition>
          Launches
        </Link>
        <span aria-hidden="true">/</span>
        <span>Watchlist</span>
      </nav>
      <header className={launches.head}>
        <p className={launches.eyebrow}>Hyvo Launches</p>
        <h1>Watchlist</h1>
        <p className={launches.lead}>The launches you saved, each read from the chain now: its phase, what its curve holds and its creator tax.</p>
        <HolderSync holder={holder} sync={saved.sync} syncError={saved.syncError} what="your watchlist" />
      </header>

      <section className={launches.section} aria-labelledby="watch-title">
        <div className={launches.sectionHead}>
          <h2 id="watch-title">
            {count === 0 ? "Nothing saved yet" : `${count.toLocaleString("en-US")} ${count === 1 ? "launch" : "launches"} saved`}
          </h2>
        </div>
        {count === 0 && (
          <p className={launches.note}>
            Open a launch and press <b>Add to watchlist</b> to keep it here.{" "}
            <Link to="/launches" className="arrow-link" viewTransition>
              See the newest launches <Arrow />
            </Link>
          </p>
        )}
        {count > 0 && state.status === "loading" && state.items.length === 0 && (
          <p className={launches.note} role="status">
            Reading {count === 1 ? "your launch" : `your ${count} launches`} from Robinhood Chain…
          </p>
        )}
        {state.status === "error" && <Failure message={state.error ?? "The chain could not be read just now."} onRetry={() => setAttempt((n) => n + 1)} />}
        {count > 0 && state.items.length > 0 && (
          <ul className={`${styles.list} stagger`} aria-label="Saved launches">
            {state.items
              .filter((item) => saved.list.includes(item.token.toLowerCase() as `0x${string}`))
              .map((item) => (
                <li key={item.token}>
                  <Row item={item} />
                  <button type="button" className={styles.remove} onClick={() => saved.set(removeFrom(saved.list, item.token))} aria-label={`Take ${item.symbol ?? shortAddress(item.token)} off the watchlist`}>
                    Remove
                  </button>
                </li>
              ))}
          </ul>
        )}
        {state.read && (
          <Provenance reads={[state.read]} served={state.served}>
            {" "}
            <button type="button" className={launches.again} onClick={() => setAttempt((n) => n + 1)} disabled={state.status === "loading"}>
              Read again
            </button>
          </Provenance>
        )}
      </section>
      <p className={launches.fine}>
        The facts above are what the chain&apos;s contracts hold; they say nothing about where a price goes. Hyvo is not affiliated with these tokens,
        their creators or Pons.
      </p>
    </article>
  );
}

function Row({ item }: { item: WatchItem }) {
  if (item.kind === "none") {
    return (
      <Link to={`/launches/${item.token}`} className={styles.item} viewTransition>
        <span className={launches.token}>
          <b>{item.symbol ?? shortAddress(item.token)}</b>
          <span className="mono">{shortAddress(item.token, 6, 4)}</span>
        </span>
        <span className={styles.itemFacts}>Not a Pons V2 launch: the factory has no record of it.</span>
      </Link>
    );
  }
  const name = distinctName(item.name, item.symbol);
  return (
    <Link to={`/launches/${item.token}`} className={styles.item} viewTransition>
      <span className={launches.token}>
        <b>{item.symbol ?? shortAddress(item.token)}</b>
        {name && <span>{name}</span>}
      </span>
      <Towards liquidity={item.liquidity} threshold={item.graduationThreshold} graduated={item.graduated || item.phase === "graduated"} />
      <span className={styles.itemFacts}>
        <span>Paired with {pairLabel(item.pair)}</span>
        <span>{phaseLabel(item.phase, item.graduated)}</span>
        <span>
          Curve holds <Amount value={item.liquidity} asset={item.pair} />
        </span>
        <span>Creator tax {formatBps(item.creatorTaxBps)}</span>
      </span>
    </Link>
  );
}
