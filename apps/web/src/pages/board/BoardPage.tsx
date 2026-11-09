import {
  boardColumns,
  boardFlags,
  CARDS_PER_COLUMN,
  COLUMN_IDS,
  CREATOR_SHARE_FLAG,
  CREATOR_TAX_FLAG_BPS,
  curveProgress,
  distinctName,
  FIRST_SECOND_SHARE_FLAG,
  formatAmount,
  formatBps,
  formatClock,
  formatDuration,
  formatPercent,
  GRADUATED_HOURS,
  NEW_MINUTES,
  NO_TRADES,
  shareOf,
  shortAddress,
  STRETCH_PROGRESS,
  TRADE_MINUTES,
  type BoardLaunch,
  type ColumnId,
  type TradeWindow,
} from "@hyvo/launches";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { Failure } from "../../components/States";
import { useDescription, useTitle } from "../../lib/use-title";
import { Age, BlockLink, pairLabel, Towards } from "../launches/parts";
import { BOARD_REFRESH_MS, useBoard, type BoardState } from "./use-board";
import styles from "./BoardPage.module.css";

const COLUMN_TEXT: Record<ColumnId, { title: string; rule: string; empty: string }> = {
  new: {
    title: "New",
    rule: `Launched in the last ${NEW_MINUTES} minutes, newest first.`,
    empty: "No Pons launch in the last hour. New ones appear here a few seconds after their block.",
  },
  stretch: {
    title: "Final stretch",
    rule: `Still on its curve and at least ${formatPercent(STRETCH_PROGRESS)} of the way to graduating, furthest first.`,
    empty: "No curve is half way to graduating just now. The board reads again every few seconds.",
  },
  graduated: {
    title: "Graduated",
    rule: `Its Uniswap V4 pool created in the last ${GRADUATED_HOURS} hours, newest first.`,
    empty: `No pool created in the last ${GRADUATED_HOURS} hours.`,
  },
};

/** Hyvo Board: every Pons launch on Robinhood Chain as it happens, read in the visitor's browser. */
export function BoardPage({ refreshMs = BOARD_REFRESH_MS }: { refreshMs?: number }) {
  useTitle("Board");
  useDescription("Every Pons launch on Robinhood Chain, live: new, close to graduating, graduated. Read from the chain in your browser. Not a trading signal.");
  const [attempt, setAttempt] = useState(0);
  const state = useBoard(refreshMs, attempt);
  const [tab, setTab] = useState<ColumnId>("new");
  const columns = useMemo(() => boardColumns(state.launches, state.now), [state.launches, state.now]);

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Board</h1>
        <p className={styles.lead}>Every Pons launch on Robinhood Chain, live: new, close to graduating, graduated.</p>
        <Status state={state} refreshMs={refreshMs} />
      </header>

      {state.status === "error" && <Failure message={state.error ?? "The chain could not be read just now."} onRetry={() => setAttempt((n) => n + 1)} />}

      {state.status !== "error" && (
        <>
          <Tabs active={tab} onChange={setTab} counts={state.status === "ready" ? { new: columns.new.length, stretch: columns.stretch.length, graduated: columns.graduated.length } : null} />
          <div className={styles.columns}>
            {COLUMN_IDS.map((id) => (
              <Column key={id} id={id} active={tab === id} state={state} launches={columns[id]} />
            ))}
          </div>
        </>
      )}

      <footer className={styles.foot}>
        {state.read && state.read.block > 0n ? (
          <p className={styles.measured}>
            Measured on-chain at block <BlockLink block={state.read.block} />. <strong>Not a trading signal.</strong>
          </p>
        ) : (
          <p className={styles.measured}>
            <strong>Not a trading signal.</strong>
          </p>
        )}
        <HowItIsRead refreshMs={refreshMs} />
      </footer>
    </article>
  );
}

function Status({ state, refreshMs }: { state: BoardState; refreshMs: number }) {
  if (state.status === "error") return null;
  return (
    <div className={styles.status}>
      <p className={styles.read}>
        <span className={state.refreshing ? "live-dot" : styles.still} aria-hidden="true" />
        {state.read && state.read.block > 0n ? (
          <span>
            Read at block <BlockLink block={state.read.block} />, {formatClock(state.read.timestamp)}.{" "}
            {state.refreshing ? "Reading the newest blocks…" : `Reads again every ${Math.round(refreshMs / 1000)} s while this tab is open.`}
          </span>
        ) : (
          <span role="status">Reading Robinhood Chain…</span>
        )}
      </p>
      {state.served.length > 0 && <p className={styles.fine}>Read in your browser through {state.served.join(", ")}.</p>}
      {state.stale && (
        <p className={styles.stale} role="status">
          {state.stale} The board shows its last read and tries again shortly.
        </p>
      )}
    </div>
  );
}

function Tabs({ active, onChange, counts }: { active: ColumnId; onChange: (id: ColumnId) => void; counts: Record<ColumnId, number> | null }) {
  const refs = useRef<Record<ColumnId, HTMLButtonElement | null>>({ new: null, stretch: null, graduated: null });
  const move = (event: KeyboardEvent, id: ColumnId) => {
    const index = COLUMN_IDS.indexOf(id);
    const next = event.key === "ArrowRight" ? COLUMN_IDS[(index + 1) % 3] : event.key === "ArrowLeft" ? COLUMN_IDS[(index + 2) % 3] : null;
    if (!next) return;
    event.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label="Columns">
      {COLUMN_IDS.map((id) => (
        <button
          key={id}
          ref={(node) => {
            refs.current[id] = node;
          }}
          type="button"
          role="tab"
          id={`board-tab-${id}`}
          aria-selected={active === id}
          aria-controls={`board-${id}`}
          tabIndex={active === id ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(event) => move(event, id)}
        >
          {COLUMN_TEXT[id].title}
          {counts && <span className="num"> {counts[id]}</span>}
        </button>
      ))}
    </div>
  );
}

function Column({ id, active, state, launches }: { id: ColumnId; active: boolean; state: BoardState; launches: BoardLaunch[] }) {
  const text = COLUMN_TEXT[id];
  const waiting = state.status === "loading" || (id !== "new" && state.history === "reading" && launches.length === 0);
  const shown = launches.slice(0, CARDS_PER_COLUMN);
  return (
    <section id={`board-${id}`} className={styles.column} data-active={active} aria-labelledby={`board-${id}-title`}>
      <div className={styles.columnHead}>
        <h2 id={`board-${id}-title`}>{text.title}</h2>
        {!waiting && <span className={`num ${styles.count}`}>{launches.length}</span>}
        <p>{text.rule}</p>
      </div>
      {waiting && <Waiting label={id === "new" ? "Reading the last hour of launches…" : `Reading the last ${GRADUATED_HOURS} hours…`} />}
      {!waiting && launches.length === 0 && <p className={styles.empty}>{text.empty}</p>}
      {!waiting && shown.length > 0 && (
        <ul className={styles.cards}>
          {shown.map((launch) => (
            <Card key={launch.token} launch={launch} column={id} now={state.now} trades={state.trades.get(launch.curve.toLowerCase()) ?? NO_TRADES} />
          ))}
        </ul>
      )}
      {!waiting && id !== "graduated" && !state.everyCurve && (
        <p className={styles.fine}>Trades counted on the curves shown only: no public endpoint answered a query across every curve just now.</p>
      )}
      {launches.length > shown.length && <p className={styles.fine}>{launches.length - shown.length} more not shown. The board shows the first {CARDS_PER_COLUMN} of each column.</p>}
      {id !== "new" && state.history === "error" && <p className={styles.fine}>The hours before the last one could not be read; this column may miss older launches.</p>}
    </section>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <div className={styles.waiting} role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span key={i} className="skeleton" />
      ))}
    </div>
  );
}

function Card({ launch, column, now, trades }: { launch: BoardLaunch; column: ColumnId; now: number; trades: TradeWindow }) {
  const label = launch.symbol ?? shortAddress(launch.token);
  const name = distinctName(launch.name, launch.symbol);
  const pair = launch.pair ? pairLabel(launch.pair) : "its pair asset";
  const share = (value: number | null) => (value === null ? <span className={styles.unknown}>Not read</span> : <span className="num">{formatPercent(value)}</span>);
  const first = launch.firstSecond;
  const flags = boardFlags(launch);
  return (
    <li className={`${styles.card} lift enter`}>
      <div className={styles.cardHead}>
        <Link to={`/launches/${launch.token}`} className={styles.open} viewTransition>
          <b>{label}</b>
          {name && <span className={styles.name}>{name}</span>}
        </Link>
        <Link to={`/check/${launch.token}`} className={styles.check} aria-label={`Check ${label} with Hyvo Check`}>
          Check
        </Link>
      </div>
      <p className={styles.meta}>
        <span>
          <Age at={launch.launchedAt} now={now} /> old
        </span>
        <span className={styles.pair}>
          <span className="visually-hidden">Pair asset: </span>
          {launch.pair ? pairLabel(launch.pair) : <span className={styles.unknown}>Pair not read</span>}
        </span>
      </p>
      <div className={styles.progress}>
        {column === "graduated" && launch.graduatedAt !== null ? (
          <span className={styles.done}>
            Graduated {formatDuration(now - launch.graduatedAt)} ago
          </span>
        ) : (
          <>
            <span className="visually-hidden">Towards graduation: </span>
            <Towards liquidity={launch.liquidity} threshold={launch.graduationThreshold} graduated={launch.graduated} />
          </>
        )}
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Creator tax</dt>
          <dd>{launch.creatorTaxBps === null ? <span className={styles.unknown}>Not read</span> : <span className="num">{formatBps(launch.creatorTaxBps)}</span>}</dd>
        </div>
        <div>
          <dt>Last {TRADE_MINUTES} min</dt>
          <dd>
            {launch.graduated === true && trades.buys + trades.sells === 0 ? (
              <span className={styles.unknown}>Trades in its pool, not counted</span>
            ) : (
              <span className="num">
                {trades.buys} {trades.buys === 1 ? "buy" : "buys"}, {trades.sells} {trades.sells === 1 ? "sell" : "sells"}, {launch.pair ? formatAmount(trades.volume, launch.pair.decimals) : "?"} {pair},{" "}
                {trades.buyers} {trades.buyers === 1 ? "buyer" : "buyers"}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Creator&apos;s wallet holds</dt>
          <dd>{share(shareOf(launch.creatorBalance, launch.supply))}</dd>
        </div>
        <div>
          <dt>Still on the curve</dt>
          <dd>{share(shareOf(launch.curveBalance, launch.supply))}</dd>
        </div>
        <div>
          <dt>First-second buyers hold</dt>
          <dd>
            {first === null ? (
              <span className={styles.unknown} title={launch.block === null ? "Launched before the hours this board reads" : undefined}>
                Not read
              </span>
            ) : first.wallets === 0 ? (
              <span className="num">No buys in the launch second</span>
            ) : (
              <>
                {share(shareOf(first.balance, launch.supply))}{" "}
                <span className={styles.unknown}>
                  ({first.wallets} {first.wallets === 1 ? "wallet" : "wallets"})
                </span>
              </>
            )}
          </dd>
        </div>
      </dl>
      {flags.length > 0 && (
        <ul className={styles.flags} aria-label={`Flags for ${label}`}>
          {flags.map((flag) => (
            <li key={flag.id}>{flag.text}</li>
          ))}
        </ul>
      )}
      {curveProgress(launch) === null && launch.graduated === null && <span className="visually-hidden">Its curve is not read yet.</span>}
    </li>
  );
}

function HowItIsRead({ refreshMs }: { refreshMs: number }) {
  return (
    <section className={styles.how} aria-labelledby="board-how-title">
      <h2 id="board-how-title">How the board reads the chain</h2>
      <p>
        Your browser asks Robinhood Chain&apos;s public endpoints for the Pons V2 launch factory&apos;s <span className="mono">TokenLaunched</span> and{" "}
        <span className="mono">PoolGraduated</span> events of the last {GRADUATED_HOURS} hours, and for the curves&apos; <span className="mono">CurveBuy</span> and{" "}
        <span className="mono">CurveSell</span> events of the last {TRADE_MINUTES} minutes. Then it reads the curves and the balances on each card through
        Multicall3, and names the block they were read at above. Every {Math.round(refreshMs / 1000)} seconds it asks only for the blocks since its last read (and
        a few seconds before them again, for an endpoint a little behind), and it stops while this tab is hidden.
      </p>
      <p>
        A launch sits in one column, the furthest it has reached. Progress is what the curve holds of its pair asset over the amount at which it graduates. The
        creator is the deployer the factory records; its share, the curve&apos;s share and the first-second buyers&apos; share are their token balances now over
        the curve&apos;s launch supply. First-second buyers are the wallets the curve&apos;s buys went to in blocks whose time is the curve&apos;s{" "}
        <span className="mono">launchedAt</span>, the creator&apos;s own wallet left out. For a launch older than the hours read, they are not read.
      </p>
      <p>
        A card names a figure when it passes a set line: the creator&apos;s wallet at {formatPercent(CREATOR_SHARE_FLAG)} of the supply or more, the first-second
        buyers at {formatPercent(FIRST_SECOND_SHARE_FLAG)} or more together, and a creator tax of {formatBps(CREATOR_TAX_FLAG_BPS)} or more. Each is a number read
        from the chain, not a judgment of the token. Anyone can send events named like a curve&apos;s, so a contract counts only when the factory&apos;s own record
        names it as its token&apos;s curve. Nothing here is advice.
      </p>
      <p>
        Every launch has its own page with the rest of its facts, and <Link to="/check">Hyvo Check</Link> reads any token. <Link to="/launches">Launches</Link>{" "}
        lists the last hours of launches with Chain Pulse.
      </p>
    </section>
  );
}
