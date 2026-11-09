// What the launches and stocks commands send, counted by host, so their output can say where they read from.
// Hosts only: an RPC URL can carry an API key in its path or query. Also the JSON form those commands print:
// every bigint as a decimal string, as `hyvo check --json` prints amounts and blocks.

import { hostOf } from "./config.js";

export interface RequestLog {
  fetch: typeof fetch;
  /** Requests sent so far, by host, in the order the hosts were first asked. */
  byHost(): [string, number][];
}

export function countRequests(base: typeof fetch): RequestLog {
  const counts = new Map<string, number>();
  return {
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const host = hostOf(url);
      counts.set(host, (counts.get(host) ?? 0) + 1);
      return base(input, init);
    },
    byHost: () => [...counts],
  };
}

/** "Read in 1.2 s: 9 requests to robinhood.drpc.org and 1 to sourcify.dev. Nothing was signed or sent." */
export function readLine(byHost: readonly (readonly [string, number])[], ms: number): string {
  const parts = byHost.map(([host, n], i) => (i === 0 ? `${n} ${n === 1 ? "request" : "requests"} to ${host}` : `${n} to ${host}`));
  const list = parts.length === 0 ? "no requests" : parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Read in ${(Math.max(0, ms) / 1000).toFixed(1)} s: ${list}. Nothing was signed or sent.`;
}

/**
 * A fetch that also stops when `signal` aborts (an MCP client cancelled the call), keeping the caller's own
 * signal (a reader's timeout) working too.
 */
export function cancellable(base: typeof fetch, signal: AbortSignal | undefined): typeof fetch {
  if (!signal) return base;
  return (input, init) => {
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const controller = new AbortController();
    const inner = init?.signal ?? undefined;
    const stop = (): void => controller.abort(signal.reason);
    const stopInner = (): void => controller.abort(inner?.reason);
    signal.addEventListener("abort", stop, { once: true });
    inner?.addEventListener("abort", stopInner, { once: true });
    if (inner?.aborted) stopInner();
    return base(input, { ...init, signal: controller.signal }).finally(() => {
      signal.removeEventListener("abort", stop);
      inner?.removeEventListener("abort", stopInner);
    });
  };
}

/** A value as --json prints it: bigints become decimal strings, nothing else changes. */
export type JsonOf<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? JsonOf<U>[]
    : T extends object
      ? { [K in keyof T]: JsonOf<T[K]> }
      : T;

export function toJson<T>(value: T): JsonOf<T> {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as JsonOf<T>;
}
