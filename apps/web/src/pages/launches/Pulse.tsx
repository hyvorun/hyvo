/**
 * Chain Pulse: the last 24 hours of Pons V2 launches, counted in the visitor's browser from the
 * factory's events and each curve's own state, reusing what the rest of the page read. Counts and
 * the facts behind them only: nothing is colored by direction, ranked by quality or rated.
 */
import { formatBps, formatPercent, shortAddress, type PulsePair, type TwinGroup, type Venue, type VenueCounts } from "@hyvo/launches";
import type { CSSProperties } from "react";
import { Link } from "react-router";
import { CountUp } from "../../components/motion-data/CountUp";
import { Decode } from "../../components/motion-data/Decode";
import { Reveal } from "../../components/Reveal";
import { PULSE_HOURS } from "../../lib/launches";
import { Provenance } from "./parts";
import type { WindowState } from "./use-launches";
import styles from "./Launches.module.css";

const count = (n: number) => Math.round(n).toLocaleString("en-US");

const VENUE_LABELS: Record<Venue, string> = {
  curve: "On its Pons curve",
  pool: "In its Uniswap V4 pool",
  between: "Off its curve, no pool yet",
  unknown: "Not read",
};

/** Bars are drawn in this order, left to right. */
const DRAWN: readonly Venue[] = ["pool", "between", "curve", "unknown"];

export function Pulse({ state }: { state: WindowState }) {
  const { pulse } = state;
  const data = pulse.data;
  const detail = data?.detail ?? null;
  return (
    <section className={styles.section} aria-labelledby="pulse-title">
      <div className={styles.sectionHead}>
        <h2 id="pulse-title">Chain Pulse: the last {PULSE_HOURS} hours</h2>
        <p>
          Every Pons V2 launch of the last {PULSE_HOURS} hours, counted in your browser from the factory&apos;s events and each curve&apos;s own state. The
          page reuses what it read above and reads only the hours before it.
        </p>
      </div>
      {pulse.status === "error" ? (
        <p className={styles.note}>{pulse.error}</p>
      ) : (
        <>
          <ul className={`${styles.stats} ${styles.pulseStats}`} aria-label={`The last ${PULSE_HOURS} hours, counted`}>
            <Stat value={data?.launches ?? null} format={count} label="Launches" />
            <Stat value={data?.pairCount ?? null} format={count} label={data?.pairCount === 1 ? "Pair asset" : "Pair assets"} />
            <Stat
              value={data?.graduated ?? null}
              format={count}
              label={
                data && data.graduated > 0
                  ? `${data.graduated === 1 ? "Curve graduated to its pool" : "Curves graduated to their pools"}, ${data.graduatedHere === data.graduated ? (data.graduated === 1 ? "launched in these hours" : "all launched in these hours") : `${data.graduatedHere} launched in these hours`}`
                  : "Curves graduated to their pools"
              }
            />
            <Stat value={detail && detail.rateKnown > 0 ? detail.taxed / detail.rateKnown : detail ? 0 : null} format={formatPercent} label="Charge a creator tax" />
            <Stat value={detail?.twinned ?? null} format={count} label="Share a symbol or a name with another launch" />
          </ul>
          <div className={styles.pulseGrid}>
            <PairPanel pairs={data?.pairs ?? null} other={data?.otherPairs ?? null} venues={detail?.venues ?? null} />
            <TaxPanel state={state} />
            <TwinPanel state={state} />
          </div>
          <div className={styles.status} aria-live="polite">
            {pulse.status === "ready" && data ? (
              <Provenance reads={pulse.reads} served={state.served} />
            ) : (
              <p className={styles.provenance} role="status">
                {pulse.status === "counted" ? "Counted from the launch events; reading each curve…" : "Reading the hours before the window…"}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ value, format, label }: { value: number | null; format: (n: number) => string; label: string }) {
  return (
    <li>
      {value === null ? <span className={`${styles.statWait} skeleton`} aria-hidden="true" /> : <b className="num"><CountUp value={value} format={format} /></b>}
      <span>{label}</span>
    </li>
  );
}

function Waiting({ rows, label }: { rows: number; label: string }) {
  return (
    <div className={styles.pulseWait} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${88 - i * 9}%` }} />
      ))}
    </div>
  );
}

const width = (part: number, whole: number) => ({ "--w": whole > 0 ? part / whole : 0 }) as CSSProperties;

function PairPanel({ pairs, other, venues }: { pairs: PulsePair[] | null; other: { pairs: number; launches: number } | null; venues: VenueCounts | null }) {
  const most = pairs?.[0]?.launches ?? 0;
  const shown = venues ? DRAWN.filter((venue) => venues[venue] > 0) : [];
  return (
    <div className={styles.pulsePanel}>
      <h3>By pair asset, and where each trades now</h3>
      {pairs === null ? (
        <Waiting rows={6} label="Counting launches by pair asset…" />
      ) : pairs.length === 0 ? (
        <p className={styles.note}>No Pons V2 launch in these hours.</p>
      ) : (
        <Reveal as="ol" className={`${styles.pulseRows} stagger`}>
          {pairs.map((pair) => (
            <li key={pair.key}>
              <span className={styles.pulseLabel}>{pair.pair?.symbol ?? shortAddress(pair.address)}</span>
              <span className={styles.pulseBar} style={width(pair.launches, most)} aria-hidden="true">
                {pair.venues ? (
                  DRAWN.filter((venue) => pair.venues![venue] > 0).map((venue) => <i key={venue} data-venue={venue} style={{ flexGrow: pair.venues![venue] }} />)
                ) : (
                  <i data-venue="pending" style={{ flexGrow: 1 }} />
                )}
              </span>
              <span className={`${styles.pulseCount} num`}>
                {count(pair.launches)}
                {pair.venues && pair.venues.pool > 0 && <span className="visually-hidden">, {pair.venues.pool} in their Uniswap V4 pools</span>}
              </span>
            </li>
          ))}
        </Reveal>
      )}
      {other && other.pairs > 0 && (
        <p className={styles.fine}>
          {count(other.launches)} more {other.launches === 1 ? "launch pairs" : "launches pair"} with {other.pairs} other {other.pairs === 1 ? "asset" : "assets"}.
        </p>
      )}
      {venues && (
        <ul className={styles.pulseLegend} aria-label="Where they trade now">
          {shown.map((venue) => (
            <li key={venue}>
              <i data-venue={venue} aria-hidden="true" /> {VENUE_LABELS[venue]}: <span className="num">{count(venues[venue])}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TaxPanel({ state }: { state: WindowState }) {
  const detail = state.pulse.data?.detail ?? null;
  const most = detail ? Math.max(...detail.rates.map((rate) => rate.launches), detail.otherRates.launches, 1) : 1;
  return (
    <div className={styles.pulsePanel}>
      <h3>Creator tax, as set at launch</h3>
      {!detail ? (
        <Waiting rows={6} label="Reading each curve's creator tax…" />
      ) : detail.rateKnown === 0 ? (
        <p className={styles.note}>No creator tax could be read in these hours.</p>
      ) : (
        <Reveal as="ol" className={`${styles.pulseRows} stagger`}>
          {detail.rates.map((rate) => (
            <li key={rate.bps}>
              <span className={`${styles.pulseLabel} num`}>{formatBps(rate.bps)}</span>
              <span className={styles.pulseBar} style={width(rate.launches, most)} aria-hidden="true">
                <i data-venue="rate" style={{ flexGrow: 1 }} />
              </span>
              <span className={`${styles.pulseCount} num`}>
                {count(rate.launches)} <span className={styles.muted}>{formatPercent(rate.launches / detail.rateKnown)}</span>
              </span>
            </li>
          ))}
          {detail.otherRates.rates > 0 && (
            <li>
              <span className={styles.pulseLabel}>Others</span>
              <span className={styles.pulseBar} style={width(detail.otherRates.launches, most)} aria-hidden="true">
                <i data-venue="rate" style={{ flexGrow: 1 }} />
              </span>
              <span className={`${styles.pulseCount} num`}>{count(detail.otherRates.launches)}</span>
            </li>
          )}
        </Reveal>
      )}
      {detail && (
        <p className={styles.fine}>
          Each curve&apos;s creatorTaxBps(), taken on its trades and paid to the creator&apos;s fee recipient.
          {detail.otherRates.rates > 0
            ? ` Others: ${count(detail.otherRates.launches)} ${detail.otherRates.launches === 1 ? "launch" : "launches"} at ${detail.otherRates.rates} other ${detail.otherRates.rates === 1 ? "rate" : "rates"}.`
            : ""}
          {detail.rateUnknown > 0 ? ` ${count(detail.rateUnknown)} could not be read.` : ""}
        </p>
      )}
    </div>
  );
}

function TwinPanel({ state }: { state: WindowState }) {
  const data = state.pulse.data;
  const detail = data?.detail ?? null;
  // A name group made of exactly the launches of a symbol group shown above it would repeat that row.
  const tokens = (group: TwinGroup) => group.launches.map((launch) => launch.token.toLowerCase()).sort().join();
  const symbols = detail ? detail.sameSymbol.slice(0, 4) : [];
  const shownSets = new Set(symbols.map(tokens));
  const names = detail ? detail.sameName.filter((group) => !shownSets.has(tokens(group))).slice(0, 2) : [];
  const groups: { kind: "symbol" | "name"; group: TwinGroup }[] = [
    ...symbols.map((group) => ({ kind: "symbol" as const, group })),
    ...names.map((group) => ({ kind: "name" as const, group })),
  ];
  return (
    <div className={styles.pulsePanel}>
      <h3>Same symbol or name</h3>
      {!detail || !data ? (
        <Waiting rows={6} label="Comparing symbols and names…" />
      ) : groups.length === 0 ? (
        <p className={styles.note}>Every launch of these hours has a symbol and a name of its own.</p>
      ) : (
        <Reveal as="ol" className={`${styles.twins} stagger`}>
          {groups.map(({ kind, group }) => (
            <li key={`${kind}:${group.launches[0]!.token}`}>
              <span className={styles.twinHead}>
                <b>{group.label}</b>
                <span className={styles.muted}>
                  {kind === "symbol" ? "symbol" : "name"}, {group.launches.length} launches
                </span>
              </span>
              <span className={styles.twinTokens}>
                {group.launches.slice(0, 3).map((launch) => (
                  <Link key={launch.token} to={`/launches/${launch.token}`} className="mono" viewTransition aria-label={`${launch.symbol ?? "Token"} at ${launch.token}`}>
                    <Decode text={shortAddress(launch.token)} />
                  </Link>
                ))}
                {group.launches.length > 3 && <span className={styles.muted}>+{group.launches.length - 3} more</span>}
              </span>
            </li>
          ))}
        </Reveal>
      )}
      {detail && data && (
        <p className={styles.fine}>
          {count(detail.twinned)} of {count(data.launches)} launches share a symbol or a name with another launch of these hours, ignoring case, spaces and a
          leading $. Anyone can launch any name, so a shared one says nothing about either token.
        </p>
      )}
    </div>
  );
}
