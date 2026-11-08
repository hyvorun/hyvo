import type { RunV1 } from "@hyvo/schema";
import { useCallback, useMemo, useRef, useState } from "react";
import { buildCrowdTimeline, crowdLayout } from "../lib/crowd";
import { formatPct, formatScaled, formatTokens, personaLabel, priceUnit, spokenPrice, type PriceUnit } from "../lib/format";
import { buildReplay, frameAt } from "../lib/replay";
import { Crowd } from "./Crowd";
import { PersonaIcon } from "./Icons";
import styles from "./Replay.module.css";
import { ReplayChart } from "./ReplayChart";
import { RoundPanel } from "./RoundPanel";
import { Transport } from "./Transport";
import { usePlayback, useWidth } from "./use-playback";

interface Props {
  run: RunV1;
  /** "hero": the home page: autoplaying and looping. */
  variant?: "full" | "hero";
}

/** The product itself: price, crowd and feed in sync, in one panel. */
export function Replay({ run, variant = "full" }: Props) {
  const hero = variant === "hero";
  const replay = useMemo(() => buildReplay(run), [run]);
  const layout = useMemo(() => crowdLayout(run.crowd.agents), [run]);
  const timeline = useMemo(() => buildCrowdTimeline(run, replay, layout), [run, replay, layout]);
  const unit = useMemo(
    () => priceUnit([replay.initialPrice, ...replay.steps.map((s) => s.price)], run.world.token.symbol),
    [replay, run],
  );
  const playback = usePlayback(run, replay, { autoplay: hero, loop: hero, initialSpeed: hero ? 2 : 1 });
  const frame = frameAt(run, replay, playback.position);
  const [chartRef, width] = useWidth<HTMLDivElement>();
  const [view, setView] = useState<"now" | "timeline">("now");
  const agents = useMemo(() => new Map(run.crowd.agents.map((a) => [a.agentId, a])), [run]);
  const showCrowd = hero || view === "now";

  const tipFor = useCallback(
    (cell: number, tokens: number) => {
      const agent = agents.get(layout.cells[cell]!.agentId);
      if (!agent) return null;
      return (
        <div className={styles.tip}>
          <b>{agent.handle}</b>
          <span className={styles.tipPersona}>
            <PersonaIcon persona={agent.persona} size={12} /> {personaLabel(agent.persona)}
          </span>
          <span className="num">
            {formatTokens(tokens)} {run.world.token.symbol}
          </span>
        </div>
      );
    },
    [agents, layout, run],
  );

  return (
    <div className={`${styles.panel} card`}>
      <div className={styles.bar}>
        <Readout run={run} unit={unit} price={frame.step.price} initial={replay.initialPrice} round={frame.round} />
        {!hero && (
          <div className={styles.views} role="group" aria-label="Replay view">
            <button type="button" aria-pressed={view === "now"} onClick={() => setView("now")}>
              Crowd now
            </button>
            <button type="button" aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>
              Timeline
            </button>
          </div>
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.main}>
          <div ref={chartRef} className={styles.chart}>
            <ReplayChart run={run} replay={replay} unit={unit} position={playback.position} width={width} horizon={showCrowd} onSeek={playback.seek} />
          </div>
          {showCrowd && (
            <div className={styles.crowd}>
              <Crowd
                layout={layout}
                timeline={timeline}
                position={playback.position}
                ariaLabel={`${run.crowd.size.toLocaleString("en-US")} synthetic agents, one dot each, filled by the tokens each one holds`}
                formatHeld={formatTokens}
                tipFor={tipFor}
              />
              <ul className={styles.keys} aria-label="Legend">
                <li>
                  <i className={styles.keyHeld} /> holding
                </li>
                <li>
                  <i className={styles.keyBuy} /> bought
                </li>
                <li>
                  <i className={styles.keySell} /> sold
                </li>
                <li>
                  <i className={styles.keyPost} /> posted
                </li>
                <li className={styles.keyTotal}>{run.world.token.symbol} held</li>
              </ul>
            </div>
          )}
        </div>
        <div className={styles.side}>
          <RoundPanel run={run} frame={frame} />
        </div>
      </div>

      <div className={styles.foot}>
        <Transport
          replay={replay}
          rounds={run.rounds.length}
          position={playback.position}
          playing={playback.playing}
          speed={playback.speed}
          onToggle={playback.toggle}
          onSeek={(p) => {
            playback.setPlaying(false);
            playback.seek(p);
          }}
          onSpeed={playback.setSpeed}
        />
      </div>
    </div>
  );
}

function Readout({ run, unit, price, initial, round }: { run: RunV1; unit: PriceUnit; price: number; initial: number; round: number }) {
  const change = ((price - initial) / initial) * 100;
  const mood = run.report.sentimentByRound[round - 1] ?? 0;
  // The price washes the way it moved.
  const previous = useRef(price);
  const tick = useRef(0);
  const direction = useRef<"up" | "down">("up");
  if (price !== previous.current) {
    direction.current = price > previous.current ? "up" : "down";
    previous.current = price;
    tick.current += 1;
  }
  return (
    <div className={styles.readout} aria-live="off">
      <div className={styles.stat}>
        <span className={styles.label}>Price</span>
        <span className={styles.priceLine}>
          <span
            key={tick.current}
            className={`${styles.price} num ${tick.current > 0 ? (direction.current === "up" ? styles.tickUp : styles.tickDown) : ""}`}
            title={`${spokenPrice(price)} ETH per token`}
          >
            {formatScaled(price, unit)}
          </span>
          <small className={styles.unit}>{unit.label}</small>
        </span>
      </div>
      <div className={styles.stat}>
        <span className={styles.label}>Since start</span>
        <span className={`${styles.value} num ${change > 0 ? styles.up : change < 0 ? styles.down : ""}`}>{formatPct(change)}</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.label}>Round</span>
        <span className={`${styles.value} num`}>
          {round}
          <small>/{run.rounds.length}</small>
        </span>
      </div>
      <div className={styles.stat} title={`Mean mood the agents reported this round, from −1 to 1`}>
        <span className={styles.label}>Crowd mood</span>
        <span className={`${styles.value} num`}>
          {Math.abs(mood) < 0.005 ? "0.00" : `${mood > 0 ? "+" : "−"}${Math.abs(mood).toFixed(2)}`}
        </span>
      </div>
    </div>
  );
}
