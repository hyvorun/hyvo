/**
 * Keys for a number whose digits roll when they change. A character is keyed by its place counted
 * from the right and by what it is, so when 1,204 becomes 1,205 only the last digit gets a new key
 * (and rolls), and when 998 becomes 1,002 the places stay matched to the ones, tens and hundreds.
 */
export function rollKeys(text: string): { key: string; char: string }[] {
  const chars = [...text];
  return chars.map((char, i) => ({ key: `${chars.length - i}:${char}`, char }));
}

/** Which way a change rolls: up for a larger number, down for a smaller one, none when equal or unknown. */
export function rollDirection(previous: number | null, next: number): "up" | "down" | "none" {
  if (previous === null || !Number.isFinite(previous) || !Number.isFinite(next) || previous === next) return "none";
  return next > previous ? "up" : "down";
}
