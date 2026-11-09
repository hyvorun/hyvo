import type { Context } from "../context.js";

/**
 * Exit codes. A check exits 0 whenever it made a report, whatever the report found: an exit code that changed
 * with the findings would be a verdict. Only `verify` uses 1, for a run that does not match its commit.
 */
export const EXIT = { ok: 0, notVerified: 1, failed: 2, usage: 64 } as const;

/** A failure that is the command's answer, with a stable code for --json. */
export class CommandError extends Error {
  override readonly name = "CommandError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Plain words for a failed request: Node's fetch only says "fetch failed" and keeps the reason in `cause`. */
export function describeError(error: unknown, host?: string): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError" || error.name === "AbortError") return `no answer from ${host ?? "the server"} in time`;
  if (error.message === "fetch failed") {
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const reason = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : "network error";
    return `could not reach ${host ?? "the server"} (${reason})`;
  }
  return error.message;
}

/** Writes a failure: a JSON object on stdout for --json, a line on stderr otherwise. */
export function printFailure(ctx: Context, json: boolean, code: string, message: string): void {
  if (json) ctx.out(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  else ctx.err(`hyvo: ${message}\n`);
}

/** A fetch that gives up after `ms` and also stops when `signal` aborts. */
export function timedFetch(base: typeof fetch, ms: number, signal?: AbortSignal): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    const stop = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop, { once: true });
    return base(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    });
  };
}
