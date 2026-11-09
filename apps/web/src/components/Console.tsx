import { DISCLAIMER, type RunV1 } from "@hyvo/schema";
import { useCallback, useMemo, type CSSProperties } from "react";
import { Link } from "react-router";
import { buildCrowdTimeline, crowdLayout } from "../lib/crowd";
import { formatDate, formatPct, formatScaled, formatTokens, personaLabel, priceUnit, spokenPrice } from "../lib/format";
import { buildReplay, frameAt, isSwap, type Replay } from "../lib/replay";
import styles from "./Console.module.css";
import { Crowd } from "./Crowd";
import { Roll } from "./motion-data/Roll";
import { Arrow, PersonaIcon } from "./Icons";
import { ReplayChart } from "./ReplayChart";
import { RoundPanel } from "./RoundPanel";
import { usePlayback, useWidth } from "./use-playback";

const whole = (n: number) => n.toLocaleString("en-US");

/** Buys, sells and posts so far, at every step of the replay. */
function countsByStep(run: RunV1, replay: Replay) {
  const size = replay.steps.length;
  const buys = new Uint32Array(size);
  const sells = new Uint32Array(size);
  const posts = new Uint32Array(size);
  let bought = 0;
  let sold = 0;
  let said = 0;
  for (const step of replay.steps) {
    if (step.kind === "post") {
      said += 1;
    } else if (step.kind === "action") {
      const action = run.rounds[step.round - 1]!.actions[step.item]!;
      if (isSwap(action) && action.status === "ok") {
        if (action.kind === "swap_buy") bought += 1;
        else sold += 1;
      }
    }
    buys[step.index] = bought;
    sells[step.index] = sold;
    posts[step.index] = said;
  }
  return { buys, sells, posts };
}

/** Who posts at the next step of the replay, so the feed can show them typing first. */
function nextPoster(run: RunV1, replay: Replay, position: number, agents: Map<string, RunV1["crowd"]["agents"][number]>): string | null {
  const next = replay.steps[position + 1];
  if (!next || next.kind !== "post") return null;
  const post = run.rounds[next.round - 1]?.posts[next.item];
  return post ? (agents.get(post.agentId)?.handle ?? post.agentId) : null;
}

/**
 * The home page's replay of the featured run, laid out as one console: what is playing, the numbers
 * so far, the price and the crowd beside the feed, and the disclaimer. It plays on a loop.
 */
export function Console({ run }: { run: RunV1 }) {
  const replay = useMemo(() => buildReplay(run), [run]);
  const layout = useMemo(() => crowdLayout(run.crowd.agents), [run]);
  const timeline = useMemo(() => buildCrowdTimeline(run, replay, layout), [run, replay, layout]);
  const counts = useMemo(() => countsByStep(run, replay), [run, replay]);
  const unit = useMemo(
    () => priceUnit([replay.initialPrice, ...replay.steps.map((s) => s.price)], run.world.token.symbol),
    [replay, run],
  );
  const playback = usePlayback(run, replay, { autoplay: true, loop: true, initialSpeed: 2 });
  const frame = frameAt(run, replay, playback.position);
  const [chartRef, width] = useWidth<HTMLDivElement>();
  const agents = useMemo(() => new Map(run.crowd.agents.map((a) => [a.agentId, a])), [run]);
  const last = replay.steps.length - 1;
  const rounds = run.rounds.length;
  const position = frame.position;
  const price = frame.step.price;
  const change = ((price - replay.initialPrice) / replay.initialPrice) * 100;
  const mood = run.report.sentimentByRound[frame.round - 1] ?? 0;

  const seek = (next: number) => {
    playback.setPlaying(false);
    playback.seek(next);
  };

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
    <div className={styles.console}>
      <div className={styles.top}>
        <button
          type="button"
          className={styles.play}
          onClick={playback.toggle}
          aria-label={playback.playing ? "Pause replay" : position >= last ? "Replay from the start" : "Play replay"}
        >
          {/* Both marks are drawn; the one that applies turns and scales in over the other. */}
          <span className={styles.icon} data-state={playback.playing ? "pause" : "play"}>
            <svg className={styles.playMark} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.2v9.6l7.5-4.8Z" />
            </svg>
            <svg className={styles.pauseMark} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.5 3.5v9M10.5 3.5v9" />
            </svg>
          </span>
        </button>
        <div className={styles.title}>
          <Link to={`/run/${run.runId}`} viewTransition>
            {run.scenario.title}
          </Link>
          <span>
            Replay of a published run, {formatDate(run.createdAt)}. {whole(run.crowd.size)} agents, {rounds} rounds,{" "}
            {run.world.forkBlock === null ? "on a local test chain, not a fork." : "on a fork of Robinhood Chain."}
          </span>
        </div>
        <span className={`${styles.round} mono`}>
          Round {frame.round} of {rounds}
        </span>
      </div>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Price, {unit.label}</dt>
          <dd className="num" title={`${spokenPrice(price)} ETH per token`}>
            <Roll text={formatScaled(price, unit)} value={price} />
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Since start</dt>
          <dd className={`num ${change > 0 ? styles.up : change < 0 ? styles.down : ""}`}>
            <Roll text={formatPct(change)} value={change} />
          </dd>
        </div>
        <div className={styles.stat} title="Mean mood the agents reported this round, from −1 to 1">
          <dt>Mood, −1 to +1</dt>
          <dd className="num">
            <Roll text={Math.abs(mood) < 0.005 ? "0.00" : `${mood > 0 ? "+" : "−"}${Math.abs(mood).toFixed(2)}`} value={mood} />
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Buys</dt>
          <dd className="num">
            <Roll text={whole(counts.buys[position]!)} value={counts.buys[position]!} />
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Sells</dt>
          <dd className="num">
            <Roll text={whole(counts.sells[position]!)} value={counts.sells[position]!} />
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Posts</dt>
          <dd className="num">
            <Roll text={whole(counts.posts[position]!)} value={counts.posts[position]!} />
          </dd>
        </div>
      </dl>

      <div className={styles.body}>
        <div className={styles.main}>
          <div ref={chartRef} className={styles.chart}>
            <ReplayChart run={run} replay={replay} unit={unit} position={position} width={width} horizon onSeek={playback.seek} />
          </div>
          <Scrubber replay={replay} rounds={rounds} position={position} onSeek={seek} onToggle={playback.toggle} />
          <div className={styles.crowd}>
            <div className={styles.crowdHead}>
              <span>The crowd. A dot fills with what its trader holds.</span>
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
              </ul>
            </div>
            <Crowd
              layout={layout}
              timeline={timeline}
              position={position}
              ariaLabel={`${whole(run.crowd.size)} synthetic agents, one dot each, filled by the tokens each one holds`}
              formatHeld={formatTokens}
              tipFor={tipFor}
            />
          </div>
        </div>
        <div className={styles.side}>
          <RoundPanel run={run} frame={frame} typing={playback.playing ? nextPoster(run, replay, position, agents) : null} live={playback.playing} />
        </div>
      </div>

      <div className={styles.foot}>
        <p>{DISCLAIMER}</p>
        <Link to={`/run/${run.runId}`} className="arrow-link" viewTransition>
          Open the full run <Arrow />
        </Link>
      </div>
    </div>
  );
}

/** The replay position, with a button per round under it. Space plays, Shift+arrows jump a round. */
function Scrubber({
  replay,
  rounds,
  position,
  onSeek,
  onToggle,
}: {
  replay: Replay;
  rounds: number;
  position: number;
  onSeek: (position: number) => void;
  onToggle: () => void;
}) {
  const last = replay.steps.length - 1;
  const step = replay.steps[position]!;
  const roundStart = replay.roundStarts[step.round - 1]!;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === " " || event.key === "k") {
      event.preventDefault();
      onToggle();
    } else if (event.shiftKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      onSeek(
        event.key === "ArrowRight"
          ? (replay.roundStarts[step.round] ?? last)
          : position > roundStart
            ? roundStart
            : (replay.roundStarts[step.round - 2] ?? 0),
      );
    }
  };

  return (
    <div className={styles.scrub} onKeyDown={onKeyDown}>
      <input
        type="range"
        min={0}
        max={last}
        value={position}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="Replay position"
        aria-valuetext={`Round ${step.round} of ${rounds}, step ${position - roundStart + 1}`}
        style={{ "--p": `${(position / Math.max(1, last)) * 100}%` } as CSSProperties}
      />
      {rounds <= 12 && (
        <div className={styles.rounds}>
          {replay.roundStarts.map((start, r) => {
            const end = replay.roundStarts[r + 1] ?? last + 1;
            return (
              <button
                key={start}
                type="button"
                style={{ flexGrow: end - start }}
                aria-label={`Jump to the end of round ${r + 1}`}
                aria-current={step.round === r + 1 ? "step" : undefined}
                onClick={() => onSeek(end - 1)}
              >
                {r + 1}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
