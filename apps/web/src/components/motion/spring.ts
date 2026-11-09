/*
 * Spring curves for CSS. A damped spring released from rest, sampled over the time it takes to
 * settle and written as a CSS linear() easing, so a transition can overshoot a little and come
 * back without any script at run time. tokens.css holds the generated strings; a unit test keeps
 * them equal to what these functions produce.
 */

/** Position of a unit spring released at 0 towards 1, for a damping ratio below 1, at time t (0 to 1). */
export function springAt(t: number, damping: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Natural frequency chosen so the envelope has shrunk to under 0.2% of the travel at t = 1.
  const omega = Math.log(1 / 0.002) / damping;
  const damped = omega * Math.sqrt(1 - damping * damping);
  const envelope = Math.exp(-damping * omega * t);
  return 1 - envelope * (Math.cos(damped * t) + ((damping * omega) / damped) * Math.sin(damped * t));
}

/** How far past the end a spring with this damping ratio travels, as a share of the travel. */
export function springOvershoot(damping: number): number {
  return Math.exp((-Math.PI * damping) / Math.sqrt(1 - damping * damping));
}

/** The spring as a CSS linear() easing with evenly spaced stops. */
export function springEasing(damping: number, stops = 28): string {
  const values: string[] = [];
  for (let i = 0; i <= stops; i++) {
    const value = springAt(i / stops, damping);
    values.push(String(Number(value.toFixed(4))));
  }
  return `linear(${values.join(", ")})`;
}

/** Where the header's nav indicator sits under a link: from the link's box, less its padding. */
export function indicatorBox(left: number, width: number, inset: number): { x: number; width: number } {
  const usable = Math.max(0, width - 2 * inset);
  return { x: Math.round((left + (usable > 0 ? inset : 0)) * 100) / 100, width: Math.round((usable > 0 ? usable : width) * 100) / 100 };
}
