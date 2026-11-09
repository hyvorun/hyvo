/**
 * The arithmetic behind numbers that count or tween into place. Pure, so it is tested on its own;
 * the components in src/components/motion-data only schedule frames.
 */

export const clamp01 = (t: number): number => (Number.isNaN(t) ? 0 : Math.min(1, Math.max(0, t)));

/** Fast at first, then settling: the curve every count on the site uses. */
export const easeOutQuart = (t: number): number => 1 - (1 - clamp01(t)) ** 4;

/** A gentler settle, for short tweens between two values. */
export const easeOutCubic = (t: number): number => 1 - (1 - clamp01(t)) ** 3;

/**
 * The value shown `elapsed` ms into a count from `from` to `to` that lasts `duration` ms. A count of
 * whole things (both ends integers) never shows a fraction on the way.
 */
export function countAt(from: number, to: number, elapsed: number, duration: number, ease: (t: number) => number = easeOutQuart): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || duration <= 0 || elapsed >= duration) return to;
  const value = from + (to - from) * ease(elapsed / duration);
  return Number.isInteger(from) && Number.isInteger(to) ? Math.round(value) : value;
}

/**
 * How long a count runs: `base` ms for a typical number, a little less for a tiny one, so that
 * counting to 3 does not crawl. Never under 360 ms or over `base`.
 */
export function countDuration(from: number, to: number, base = 900): number {
  const span = Math.abs(to - from);
  if (!Number.isFinite(span) || span === 0) return 0;
  if (span >= 10 || !Number.isInteger(span)) return base;
  return Math.max(360, Math.round(base * (0.4 + span * 0.06)));
}
