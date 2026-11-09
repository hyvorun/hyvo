// One place for every HTTP request a check makes: the injected fetch, the caller's abort signal, a time limit
// per request, and a count of requests by destination (a Cloudflare Worker counts each one as a subrequest).
// Uses only what browsers, Node 18+ and Workers all provide: no AbortSignal.any, no Node modules.

import type { FetchLike } from "./types.js";

export type Destination = "rpc" | "sourcify" | "blockscout";

export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    message: string,
    readonly kind: "timeout" | "aborted" | "network" | "http",
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface NetOptions {
  fetch: FetchLike;
  signal?: AbortSignal;
  timeoutMs: number;
}

export class Net {
  readonly requests: Record<Destination, number> = { rpc: 0, sourcify: 0, blockscout: 0 };

  constructor(private readonly opts: NetOptions) {}

  get aborted(): boolean {
    return this.opts.signal?.aborted ?? false;
  }

  /** Sends one request and returns the status and body text. Throws HttpError on timeout, abort or network failure. */
  async request(
    destination: Destination,
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; ok: boolean; text: string }> {
    if (this.aborted) throw new HttpError("the check was aborted", "aborted");
    const controller = new AbortController();
    let timedOut = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs);
    const onAbort = (): void => controller.abort();
    this.opts.signal?.addEventListener("abort", onAbort);
    this.requests[destination]++;
    try {
      const res = await this.opts.fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    } catch (error) {
      if (this.aborted) throw new HttpError("the check was aborted", "aborted");
      if (timedOut) throw new HttpError(`no answer within ${this.opts.timeoutMs} ms from ${hostOf(url)}`, "timeout");
      throw new HttpError(`request to ${hostOf(url)} failed: ${error instanceof Error ? error.message : String(error)}`, "network");
    } finally {
      clearTimeout(timer);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** The host of a URL, for messages: an RPC URL can carry an API key in its path or query. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
