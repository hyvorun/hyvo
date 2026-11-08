import type { CSSProperties } from "react";
import type { Replay } from "../lib/replay";
import styles from "./Transport.module.css";
import { SPEEDS, type Speed } from "./use-playback";

interface Props {
  replay: Replay;
  rounds: number;
  position: number;
  playing: boolean;
  speed: Speed;
  onToggle: () => void;
  onSeek: (position: number) => void;
  onSpeed: (speed: Speed) => void;
}

/** Play/pause, a scrubber over every step with round marks, and the speed. Keyboard: Space plays,
 * arrows step, Shift+arrows jump a round, Home/End go to the ends. */
export function Transport({ replay, rounds, position, playing, speed, onToggle, onSeek, onSpeed }: Props) {
  const step = replay.steps[position]!;
  const last = replay.steps.length - 1;
  const roundStart = replay.roundStarts[step.round - 1]!;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === " " || event.key === "k") {
      event.preventDefault();
      onToggle();
    } else if (event.shiftKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      const target =
        event.key === "ArrowRight"
          ? (replay.roundStarts[step.round] ?? last)
          : position > roundStart
            ? roundStart
            : (replay.roundStarts[step.round - 2] ?? 0);
      onSeek(target);
    }
  };

  return (
    <div className={styles.transport} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={styles.play}
        onClick={onToggle}
        aria-label={playing ? "Pause replay" : position >= last ? "Replay from the start" : "Play replay"}
      >
        <span key={playing ? "pause" : "play"} className={styles.icon}>
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="2.8" width="3" height="10.4" rx="1" />
              <rect x="9.5" y="2.8" width="3" height="10.4" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.2-4.8a.6.6 0 0 0 0-1l-7.2-4.8A.6.6 0 0 0 5 3.2Z" />
            </svg>
          )}
        </span>
      </button>

      <div className={styles.track} style={{ "--p": `${(position / Math.max(1, last)) * 100}%` } as CSSProperties}>
        <input
          type="range"
          min={0}
          max={last}
          value={position}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="Replay position"
          aria-valuetext={`Round ${step.round} of ${rounds}, step ${position - roundStart + 1}`}
        />
        <div className={styles.marks} aria-hidden="true">
          {replay.roundStarts.map((start) => (
            <span key={start} style={{ left: `${(start / Math.max(1, last)) * 100}%` }} />
          ))}
        </div>
      </div>

      <span className={styles.round}>
        R{step.round}/{rounds}
      </span>

      <div className={styles.speeds} role="group" aria-label="Replay speed">
        {SPEEDS.map((s) => (
          <button key={s} type="button" aria-pressed={s === speed} onClick={() => onSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
