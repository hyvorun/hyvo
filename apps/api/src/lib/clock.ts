/** Time in Unix seconds, with an override for tests. */
let override: (() => number) | null = null;

export function nowS(): number {
  return override ? override() : Math.floor(Date.now() / 1000);
}

/** Tests only: freeze or move time; `null` restores the real clock. */
export function setClock(fn: (() => number) | null): void {
  override = fn;
}

/** Unix seconds of a `YYYY-MM-DDTHH:MM:SSZ` timestamp. */
export function parseIso(text: string): number {
  return Math.floor(Date.parse(text) / 1000);
}

export function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isoOrNull(seconds: number | null | undefined): string | null {
  return seconds === null || seconds === undefined ? null : iso(seconds);
}

/** `YYYY-MM-DD` (UTC). */
export function utcDay(seconds: number): string {
  return iso(seconds).slice(0, 10);
}

/** `YYYY-MM` (UTC). */
export function utcMonth(seconds: number): string {
  return iso(seconds).slice(0, 7);
}

export function startOfUtcDay(seconds: number): number {
  return seconds - (seconds % 86_400);
}
