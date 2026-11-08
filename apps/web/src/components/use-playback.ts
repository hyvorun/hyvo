import type { RunV1 } from "@hyvo/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Replay, stepDuration } from "../lib/replay";

export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Replay position and transport. `autoplay` starts playing on mount unless the viewer prefers
 * reduced motion (then the replay opens at the end, showing the whole run). `loop` restarts after
 * a pause at the end (the home page hero).
 */
export function usePlayback(run: RunV1, replay: Replay, { autoplay = false, loop = false, initialSpeed = 1 as Speed } = {}) {
  const last = replay.steps.length - 1;
  const reduced = prefersReducedMotion();
  const [position, setPosition] = useState(() => (reduced || !autoplay ? last : 0));
  const [playing, setPlaying] = useState(autoplay && !reduced);
  const [speed, setSpeed] = useState<Speed>(initialSpeed);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!playing) return;
    const step = replay.steps[position];
    if (!step) return;
    const atEnd = position >= last;
    const delay = atEnd ? 2600 : stepDuration(run, step) / speed;
    timer.current = window.setTimeout(() => {
      if (!atEnd) setPosition((p) => Math.min(p + 1, last));
      else if (loop) setPosition(0);
      else setPlaying(false);
    }, delay);
    return () => window.clearTimeout(timer.current);
  }, [playing, position, speed, last, loop, run, replay]);

  const seek = useCallback(
    (next: number) => setPosition(Math.max(0, Math.min(Math.round(next), last))),
    [last],
  );
  const toggle = useCallback(() => {
    setPlaying((now) => {
      if (!now && position >= last) setPosition(0); // play again from the start
      return !now;
    });
  }, [position, last]);

  return { position, playing, speed, setSpeed, seek, toggle, setPlaying };
}

/** Width of an element in CSS pixels, kept current. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(element);
    setWidth(Math.round(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
