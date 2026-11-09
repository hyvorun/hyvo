import { distinctName, formatAmount, formatBps, formatPercent, NATIVE, shortAddress, type Launch } from "@hyvo/launches";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Failure } from "../../components/States";
import { RECENT_MINUTES, WINDOWS, tokenFromPath, windowFrom } from "../../lib/launches";
import { useDescription, useTitle } from "../../lib/use-title";
import { Atlas } from "./Atlas";
import { Age, Amount, pairLabel, Provenance, Towards } from "./parts";
import { useLaunchWindow, type WindowState } from "./use-launches";
import styles from "./Launches.module.css";

const PAGE = 25;

/** Hyvo Launches: every Pons V2 launch of the last hours, read from the chain in the visitor's browser. */
export function LaunchesPage() {
  useTitle("Launches");
  useDescription("New Pons launches on Robinhood Chain as they land, with the facts their contracts hold: pair asset, phase, creator tax and liquidity, read from the chain in your browser. Not a trading signal.");
  const [params, setParams] = useSearchParams();
  const choice = windowFrom(params.get("window"));
  const [attempt, setAttempt] = useState(0);
  const state = useLaunchWindow(choice.hours, attempt);
  const now = state.head?.timestamp ?? Math.floor(Date.now() / 1000);

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>Launches</p>
        <h1>Every Pons launch, read from the chain</h1>
        <p className={styles.lead}>
          New tokens launched through Pons on Robinhood Chain, with the facts their contracts hold: what each one is paired with, where it trades, its creator
          tax and how much its curve holds. Your browser reads them from the chain itself. Hyvo&apos;s servers are not in between, and nothing is stored.
        </p>
        <div className={styles.controls}>
          <nav className={styles.windows} aria-label="Time window">
            {WINDOWS.map((item) => (
              <Link
                key={item.id}
                to={`?window=${item.id}`}
                replace
                aria-current={item.id === choice.id ? "true" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  setParams(item.id === "6h" ? {} : { window: item.id }, { replace: true });
                }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <LookUp />
        </div>
        <div className={styles.status} aria-live="polite">
          {state.status === "error" ? null : state.reads.length > 0 ? (
            <Provenance reads={state.reads} served={state.served}>
              {" "}
              <button type="button" className={styles.again} onClick={() => setAttempt((n) => n + 1)} disabled={state.status !== "ready"}>
                Read again
              </button>
            </Provenance>
          ) : (
            <p className={styles.provenance} role="status">
              Reading Robinhood Chain…
            </p>
          )}
        </div>
      </header>

      {state.status === "error" && <Failure message={state.error ?? "The chain could not be read just now."} onRetry={() => setAttempt((n) => n + 1)} />}

      {state.status !== "error" && (
        <>
          <Stats state={state} hours={choice.hours} />
          <div className={styles.split}>
            <Movers state={state} now={now} />
            <section className={styles.section} aria-labelledby="map-title">
              <div className={styles.sectionHead}>
                <h2 id="map-title">By pair asset</h2>
                <p>
                  Each launch sits around the asset it trades against, closer the further its curve is towards graduation. A core grows with the number of launches
                  that chose it.
                </p>
              </div>
              {state.status === "ready" ? (
                <Atlas launches={state.launches} />
              ) : (
                <div className={`${styles.mapWait} skeleton`} role="status" aria-label="Reading the whole window…" />
              )}
            </section>
          </div>
          <Newest state={state} now={now} hours={choice.hours} />
          <HowItIsRead />
        </>
      )}
    </article>
  );
}

function LookUp() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = tokenFromPath(value.trim());
    if (!token) {
      setError(true);
      return;
    }
    navigate(`/launches/${token}`, { viewTransition: true });
  };
  return (
    <form className={styles.lookup} onSubmit={submit} noValidate>
      <label htmlFor="lookup">Look up a token</label>
      <div>
        <input
          id="lookup"
          className="mono"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(false);
          }}
          placeholder="0x… token address"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error || undefined}
          aria-describedby={error ? "lookup-error" : undefined}
        />
        <button type="submit" className="btn btn-ghost btn-sm">
          Look up
        </button>
      </div>
      {error && (
        <p id="lookup-error" className={styles.inputError}>
          Enter a token address: 0x and 40 hexadecimal characters.
        </p>
      )}
    </form>
  );
}

function Stats({ state, hours }: { state: WindowState; hours: number }) {
  const ready = state.status === "ready";
  const launches = state.launches;
  const pairs = new Set(launches.map((launch) => launch.pair.address.toLowerCase()));
  const notEth = launches.filter((launch) => launch.pair.address !== NATIVE).length;
  const taxed = launches.filter((launch) => (launch.creatorTaxBps ?? 0) > 0).length;
  const movers = state.movers.data;
  const span = hours === 1 ? "the last hour" : `the last ${hours} hours`;
  const items = [
    { value: ready ? launches.length.toLocaleString("en-US") : null, label: `Launches in ${span}` },
    { value: ready ? state.graduations.length.toLocaleString("en-US") : null, label: `Graduated in ${span}` },
    { value: ready ? (launches.length ? formatPercent(notEth / launches.length) : "0%") : null, label: `Paired with something other than ETH, across ${pairs.size} pair asset${pairs.size === 1 ? "" : "s"}` },
    { value: ready ? (launches.length ? formatPercent(taxed / launches.length) : "0%") : null, label: "Charge a creator tax on trades" },
    { value: movers ? movers.trades.toLocaleString("en-US") : null, label: `Trades on Pons curves in the last ${RECENT_MINUTES} minutes` },
  ];
  return (
    <ul className={styles.stats} aria-label={`The ${span} on Pons`}>
      {items.map((item) => (
        <li key={item.label}>
          {item.value === null ? <span className={`${styles.statWait} skeleton`} aria-hidden="true" /> : <b className="num">{item.value}</b>}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Movers({ state, now }: { state: WindowState; now: number }) {
  const { movers } = state;
  return (
    <section className={styles.section} aria-labelledby="movers-title">
      <div className={styles.sectionHead}>
        <h2 id="movers-title">Most traded in the last {RECENT_MINUTES} minutes</h2>
        <p>Buys and sells on Pons bonding curves, counted from the chain&apos;s own trade events. Trades after graduation happen on Uniswap and are not counted.</p>
      </div>
      {movers.status === "loading" && <RowsWaiting count={4} label="Counting trades…" />}
      {movers.status === "error" && <p className={styles.note}>{movers.error}</p>}
      {movers.status === "ready" && movers.data && movers.data.rows.length === 0 && <p className={styles.note}>No trades on a Pons curve in these blocks.</p>}
      {movers.status === "ready" && movers.data && movers.data.rows.length > 0 && (
        <>
          <ol className={styles.movers}>
            {movers.data.rows.map(({ launch, activity }) => (
              <li key={launch.curve}>
                <Link to={`/launches/${launch.token}`} className={styles.rowLink} viewTransition>
                  <span className={styles.token}>
                    <b>{launch.symbol ?? shortAddress(launch.token)}</b>
                    <span>{distinctName(launch.name, launch.symbol) ?? ""}</span>
                  </span>
                  <span className={styles.pair}>
                    <span className="visually-hidden">Pair asset: </span>
                    {pairLabel(launch.pair)}
                  </span>
                  <span className={styles.figures}>
                    <span className={`${styles.count} ${styles.cTrades}`}>
                      <span>
                        <b className="num">{activity.trades}</b> trades
                      </span>
                      <span className={styles.split2}>
                        <span className={styles.buys}>
                          <i aria-hidden="true" />
                          <span className="num">{activity.buys}</span> buys
                        </span>
                        <span className={styles.sells}>
                          <i aria-hidden="true" />
                          <span className="num">{activity.sells}</span> sells
                        </span>
                      </span>
                    </span>
                    <span className={`${styles.count} ${styles.cTraders}`}>
                      <span>
                        <b className="num">{activity.traders}</b> {activity.traders === 1 ? "trader" : "traders"}
                      </span>
                    </span>
                    <span className={`${styles.count} ${styles.cVolume}`}>
                      <span>
                        <b className="num">{formatAmount(activity.volume, launch.pair.decimals)}</b> {pairLabel(launch.pair)} traded
                      </span>
                    </span>
                  </span>
                  <span className={styles.age}>
                    Launched <Age at={launch.launchedAt} now={now} /> ago
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          <p className={styles.fine}>
            {movers.data.trades.toLocaleString("en-US")} trades on {movers.data.curves.toLocaleString("en-US")} curves
            {movers.data.everyCurve ? "" : " among the newest launches only: no public endpoint answered a query across every curve"}
            {movers.data.dropped > 0
              ? movers.data.dropped === 1
                ? ". One other contract sent the same events and is not a Pons curve, so it is left out"
                : `. ${movers.data.dropped} other contracts sent the same events and are not Pons curves, so they are left out`
              : ""}
            .
          </p>
        </>
      )}
    </section>
  );
}

function Newest({ state, now, hours }: { state: WindowState; now: number; hours: number }) {
  const [shown, setShown] = useState(PAGE);
  const [filter, setFilter] = useState("");
  const list = useMemo(() => {
    const key = filter.trim().toLowerCase();
    if (!key) return state.launches;
    return state.launches.filter((launch) => [launch.symbol, launch.name, launch.token, launch.pair.symbol].some((value) => value?.toLowerCase().includes(key)));
  }, [state.launches, filter]);
  const loading = state.status === "loading";
  return (
    <section className={styles.section} aria-labelledby="newest-title">
      <div className={styles.sectionHead}>
        <h2 id="newest-title">Newest launches</h2>
        <p>
          Newest first. A launch appears here a few seconds after its block.
          {state.status === "partial" ? " The rest of the window is still being read." : ""}
        </p>
      </div>
      {!loading && state.launches.length > 0 && (
        <div className={styles.filter}>
          <label htmlFor="filter">Filter</label>
          <input id="filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Symbol, name, pair or address" autoComplete="off" spellCheck={false} />
          <span className={styles.fine} aria-live="polite">
            {filter ? `${list.length} of ${state.launches.length}` : `${state.launches.length} launches`}
          </span>
        </div>
      )}
      {loading && <RowsWaiting count={6} label="Reading the newest launches…" />}
      {!loading && state.launches.length === 0 && <p className={styles.note}>No Pons launch in {hours === 1 ? "the last hour" : `the last ${hours} hours`}.</p>}
      {list.length > 0 && (
        <>
          <div className={styles.columns} aria-hidden="true">
            <span>Age</span>
            <span>Token</span>
            <span>Pair</span>
            <span>Towards graduation</span>
            <span>On its curve</span>
            <span>Creator tax</span>
          </div>
          <ul className={styles.rows}>
            {list.slice(0, shown).map((launch) => (
              <LaunchRow key={launch.token} launch={launch} now={now} />
            ))}
          </ul>
        </>
      )}
      {list.length > shown && (
        <button type="button" className={`btn btn-ghost btn-sm ${styles.more}`} onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, list.length - shown)} more
        </button>
      )}
    </section>
  );
}

function LaunchRow({ launch, now }: { launch: Launch; now: number }) {
  return (
    <li>
      <Link to={`/launches/${launch.token}`} className={styles.rowLink} viewTransition>
        <span className={styles.age}>
          <span className="visually-hidden">Launched </span>
          <Age at={launch.launchedAt} now={now} />
          <span className="visually-hidden"> ago</span>
        </span>
        <span className={styles.token}>
          <b>{launch.symbol ?? shortAddress(launch.token)}</b>
          <span>{distinctName(launch.name, launch.symbol) ?? ""}</span>
        </span>
        <span className={styles.pair}>
          <span className="visually-hidden">Pair asset: </span>
          {pairLabel(launch.pair)}
        </span>
        <span className={styles.progressCell}>
          <span className="visually-hidden">Towards graduation: </span>
          <Towards liquidity={launch.liquidity} threshold={launch.graduationThreshold} graduated={launch.graduated} />
        </span>
        <span className={styles.liquidity}>
          <span className="visually-hidden">On its curve: </span>
          {launch.graduated ? <span className={styles.unknown}>Moved to its pool</span> : <Amount value={launch.liquidity} asset={launch.pair} />}
        </span>
        <span className={styles.tax}>
          <span className={styles.taxLabel}>Creator tax </span>
          {launch.creatorTaxBps === null ? <span className={styles.unknown}>Not read</span> : <span className="num">{formatBps(launch.creatorTaxBps)}</span>}
        </span>
      </Link>
    </li>
  );
}

function RowsWaiting({ count, label }: { count: number; label: string }) {
  return (
    <div className={styles.waiting} role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${92 - i * 9}%` }} />
      ))}
    </div>
  );
}

function HowItIsRead() {
  return (
    <section className={styles.section} aria-labelledby="how-title">
      <div className={styles.sectionHead}>
        <h2 id="how-title">How this page reads the chain</h2>
      </div>
      <div className={styles.prose}>
        <p>
          Your browser asks Robinhood Chain&apos;s public endpoints for the <span className="mono">TokenLaunched</span> and <span className="mono">PoolGraduated</span>{" "}
          events of the Pons V2 launch factory over the window you chose, then reads each launch&apos;s bonding curve: what it holds of its pair asset, the
          creator tax set at launch, and whether it has graduated. All of those reads happen in one call at one block, and that block is the one named above.
        </p>
        <p>
          Trades are the curves&apos; own <span className="mono">CurveBuy</span> and <span className="mono">CurveSell</span> events. Anyone can write a contract that
          sends events with the same names, so a contract counts only when the factory&apos;s own record of its token names it as that token&apos;s curve.
        </p>
        <p>
          A curve graduates when it holds its threshold of the pair asset; the token then trades in a Uniswap V4 pool, and its curve stops. Distance on the map and the
          bar in the list are that one ratio. None of this rates a token. It is not a trading signal, and nothing here is advice.
        </p>
        <p>
          Every launch has its own page with the rest of its facts, and a link to <Link to="/check">Hyvo Check</Link>.
        </p>
      </div>
    </section>
  );
}
