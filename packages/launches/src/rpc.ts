/**
 * A small JSON-RPC reader for public Robinhood Chain endpoints, made for a browser (or a Worker, or a
 * CLI): fetch only, no keys. Public endpoints differ and change their minds: one serves `eth_getLogs`
 * over 50,000 blocks and the next node behind the same name over 10,001, one wants an address in
 * every log filter and allows ten of them, one is rate limited (docs/OPEN_ITEMS.md item 28). So the
 * reader learns each endpoint's limits from its refusals, splits log queries to fit, and moves on to
 * the next endpoint when one is down, busy or refuses. It never sends a transaction: the only
 * methods it uses read.
 */
import type { Address, Hex } from "viem";

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  /** Some endpoints add the block's time to each log. */
  blockTimestamp?: Hex;
  removed?: boolean;
}

export interface LogQuery {
  /** Without an address the query matches every emitter, which only some endpoints serve. */
  address?: Address | Address[];
  topics: (Hex | Hex[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

export interface BlockHeader {
  number: bigint;
  timestamp: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A log endpoint, with the widest span it is first asked for when that is known. */
export type LogEndpointOption = string | { url: string; maxSpan?: number };

export interface ReaderOptions {
  /** For eth_call, eth_blockNumber and block headers, tried in order. */
  callEndpoints: readonly string[];
  /** For eth_getLogs, tried in order. */
  logEndpoints: readonly LogEndpointOption[];
  fetch?: FetchLike;
  timeoutMs?: number;
  /** First guess at the widest log span; refusals bring it down per endpoint. */
  maxSpan?: number;
  /** Log requests in flight at once. */
  concurrency?: number;
  /** Endpoints known to refuse a body sent as plain text: they get JSON from the start. */
  jsonOnly?: readonly string[];
}

/** The only JSON-RPC methods this reader ever sends. */
const READ_METHODS = new Set(["eth_blockNumber", "eth_call", "eth_getBlockByNumber", "eth_getLogs", "eth_chainId"]);

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined = undefined,
    readonly endpoint: string | undefined = undefined,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** No endpoint could answer; `reasons` says what each one said. */
export class RpcUnavailableError extends Error {
  constructor(
    readonly method: string,
    readonly reasons: string[],
  ) {
    super(`No public endpoint answered ${method}${reasons.length ? `: ${reasons.slice(-3).join("; ")}` : ""}`);
    this.name = "RpcUnavailableError";
  }
}

interface LogEndpoint {
  url: string;
  maxSpan: number;
  maxAddresses: number;
  needsAddress: boolean;
  /** Only serves recent blocks, or refused log queries outright: skipped from then on. */
  disabled: boolean;
  /** Has answered a log query at its current limits; until then it is asked one piece at a time. */
  proven: boolean;
}

type Outcome =
  | { kind: "ok"; result: unknown }
  | { kind: "span"; limit: number | null; message: string }
  | { kind: "addresses"; limit: number | null; message: string }
  | { kind: "needs-address"; message: string }
  | { kind: "unusable"; message: string }
  | { kind: "retry"; message: string }
  | { kind: "fatal"; message: string; code: number | undefined };

const MIN_USEFUL_SPAN = 1_000;

/** A refusal of the block span, with the limit when the message names one. */
export function spanLimit(message: string): { refused: boolean; limit: number | null } {
  const text = message.toLowerCase();
  const refused =
    /block range|range (limit|exceed|too)|ranges? over|max(imum)? (block )?range|spans? \d+ blocks|exceeds? \d+ blocks|too large|block count/.test(text) &&
    !/address/.test(text.replace(/add an address filter/, ""));
  if (!refused) return { refused: false, limit: null };
  const patterns = [
    /max(?:imum)?\s*[=:]?\s*(\d[\d,]*)/, // "max=10000", "maximum 50000", "(max 10001 blocks)"
    /only (\d[\d,]*) (?:are|is) allowed/, // "but only 30000 are allowed"
    /exceeds (\d[\d,]*) blocks/, // "exceeds 100 blocks"
    /max block range (\d[\d,]*)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const limit = Number(match[1].replace(/,/g, ""));
      if (Number.isSafeInteger(limit) && limit > 0) return { refused: true, limit };
    }
  }
  return { refused: true, limit: null };
}

function classify(message: string, code: number | undefined): Exclude<Outcome, { kind: "ok" }> {
  const text = message.toLowerCase();
  if (/missing required field 'address'|address (filter )?(is )?required|requires? an? address/.test(text)) {
    return { kind: "needs-address", message };
  }
  const addresses = /maximum of (\d+) addresses|(\d+) addresses per request/.exec(text);
  if (addresses) return { kind: "addresses", limit: Number(addresses[1] ?? addresses[2]), message };
  if (/recent blocks|most recent \d+ blocks|older than|personal token|api key|register at|archive requests?|not supported on free plan/.test(text)) {
    const span = spanLimit(message);
    // dRPC's free plan names 10,000 in its refusal but answers about 100 blocks: too small to use.
    if (span.refused && /free plan/.test(text)) return { kind: "unusable", message };
    if (!span.refused) return { kind: "unusable", message };
  }
  const span = spanLimit(message);
  if (span.refused) return { kind: "span", limit: span.limit, message };
  if (code === 429 || code === -32005 || code === -32029 || /rate limit|too many requests|busy|timeout|timed out|unavailable|try again|internal error|historical state|missing trie|header not found|upstream|gateway|overloaded|capacity/.test(text)) {
    return { kind: "retry", message };
  }
  return { kind: "fatal", message, code };
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const hex = (n: bigint) => `0x${n.toString(16)}`;

export class ChainReader {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly callUrls: string[];
  private readonly logs: LogEndpoint[];
  /** Hosts that answered, for the "read through" line under the facts. */
  readonly served = new Set<string>();
  /** HTTP requests sent, and how many of them were refused or failed. */
  readonly stats = { requests: 0, refused: 0 };
  private id = 0;
  /** Endpoints that refuse a JSON-RPC body sent as plain text. */
  private readonly jsonOnly = new Set<string>();

  constructor(options: ReaderOptions) {
    if (options.callEndpoints.length === 0 || options.logEndpoints.length === 0) throw new Error("ChainReader needs at least one endpoint of each kind");
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.callUrls = [...options.callEndpoints];
    for (const url of options.jsonOnly ?? []) this.jsonOnly.add(url);
    const maxSpan = options.maxSpan ?? 50_000;
    this.logs = options.logEndpoints.map((option) => {
      const { url, maxSpan: first } = typeof option === "string" ? { url: option, maxSpan: undefined } : option;
      // A span given for the endpoint was measured, so it is not probed first; a guess is.
      return { url, maxSpan: first ?? maxSpan, maxAddresses: 1_000, needsAddress: false, disabled: false, proven: first !== undefined };
    });
  }

  private async post(url: string, method: string, params: unknown[]): Promise<Outcome> {
    if (!READ_METHODS.has(method)) throw new Error(`${method} is not a read`);
    const outcome = await this.send(url, method, params);
    this.stats.requests += 1;
    if (outcome.kind !== "ok") this.stats.refused += 1;
    return outcome;
  }

  private async send(url: string, method: string, params: unknown[]): Promise<Outcome> {
    // Plain text first: a browser sends it without a CORS preflight, one round trip less. An endpoint
    // that wants JSON says so (HTTP 415), and gets JSON from then on.
    const plain = !this.jsonOnly.has(url);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": plain ? "text/plain;charset=UTF-8" : "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { kind: "retry", message: `${host(url)}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const text = await response.text().catch(() => "");
    if (plain && (response.status === 415 || /invalid content.?type|only application\/json/i.test(text.slice(0, 200)))) {
      this.jsonOnly.add(url);
      return this.send(url, method, params);
    }
    let body: { result?: unknown; error?: { code?: number; message?: string } } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (body?.error) {
      const outcome = classify(String(body.error.message ?? ""), body.error.code);
      return outcome.kind === "fatal" ? outcome : { ...outcome, message: `${host(url)}: ${outcome.message}` };
    }
    if (response.status === 429 || response.status >= 500 || !response.ok || !body || !("result" in body)) {
      return { kind: "retry", message: `${host(url)}: HTTP ${response.status}` };
    }
    this.served.add(host(url));
    return { kind: "ok", result: body.result };
  }

  /** One read call, trying each call endpoint in order, twice round. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const reasons: string[] = [];
    for (let round = 0; round < 2; round++) {
      for (const url of this.callUrls) {
        const outcome = await this.post(url, method, params);
        if (outcome.kind === "ok") return outcome.result as T;
        if (outcome.kind === "fatal") throw new RpcError(outcome.message, outcome.code, host(url));
        reasons.push(outcome.message);
      }
      if (round === 0) await sleep(300);
    }
    throw new RpcUnavailableError(method, reasons);
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_blockNumber"));
  }

  /**
   * Opens the connection to the first log endpoint while other requests are under way, so its
   * first log query does not wait for a handshake. The answer is not used.
   */
  warm(): void {
    const first = this.logs.find((endpoint) => !endpoint.disabled);
    if (first && first.url !== this.callUrls[0]) void this.post(first.url, "eth_blockNumber", []).catch(() => undefined);
  }

  async header(block: bigint | "latest"): Promise<BlockHeader> {
    const raw = await this.call<{ number: Hex; timestamp: Hex } | null>("eth_getBlockByNumber", [block === "latest" ? block : hex(block), false]);
    if (!raw) throw new RpcError(`block ${block} is not available`);
    return { number: BigInt(raw.number), timestamp: Number(BigInt(raw.timestamp)) };
  }

  async ethCall(to: Address, data: Hex, block: bigint | "latest" = "latest"): Promise<Hex> {
    return this.call<Hex>("eth_call", [{ to, data }, block === "latest" ? block : hex(block)]);
  }

  /**
   * Logs over any block range: the range is cut to what each endpoint serves, and an address list to
   * what it accepts. A query without an address goes only to endpoints that answer one.
   */
  async getLogs(query: LogQuery): Promise<RawLog[]> {
    if (query.toBlock < query.fromBlock) return [];
    const addresses = query.address === undefined ? null : Array.isArray(query.address) ? query.address : [query.address];
    if (addresses && addresses.length === 0) return [];
    type Piece = { from: bigint; to: bigint; addresses: Address[] | null; attempts: number };
    const found: RawLog[] = [];
    const reasons: string[] = [];
    const giveUpAfter = 2 * this.logs.length + 2;
    let requests = 0;

    const pick = (piece: Piece): LogEndpoint | null => {
      const usable = this.logs.filter((endpoint) => !endpoint.disabled && (piece.addresses !== null || !endpoint.needsAddress));
      return usable[piece.attempts % Math.max(1, usable.length)] ?? null;
    };

    // One piece: cut it to the endpoint's known limits, or ask and sort out the answer. Whatever is
    // left to do goes into `next`.
    const settle = async (piece: Piece, next: Piece[]): Promise<void> => {
      const endpoint = pick(piece);
      if (!endpoint) throw new RpcUnavailableError("eth_getLogs", reasons);
      const span = BigInt(endpoint.maxSpan);
      if (piece.to - piece.from + 1n > span) {
        for (let from = piece.from; from <= piece.to; from += span) {
          next.push({ ...piece, from, to: from + span - 1n < piece.to ? from + span - 1n : piece.to });
        }
        return;
      }
      if (piece.addresses && piece.addresses.length > endpoint.maxAddresses) {
        for (let i = 0; i < piece.addresses.length; i += endpoint.maxAddresses) {
          next.push({ ...piece, addresses: piece.addresses.slice(i, i + endpoint.maxAddresses) });
        }
        return;
      }
      if (++requests > 400) throw new RpcUnavailableError("eth_getLogs", [...reasons, "the range needs too many requests"]);
      const filter: Record<string, unknown> = { fromBlock: hex(piece.from), toBlock: hex(piece.to), topics: query.topics };
      if (piece.addresses) filter.address = piece.addresses.length === 1 ? piece.addresses[0] : piece.addresses;
      const outcome = await this.post(endpoint.url, "eth_getLogs", [filter]);
      switch (outcome.kind) {
        case "ok":
          if (Array.isArray(outcome.result)) {
            endpoint.proven = true;
            found.push(...(outcome.result as RawLog[]));
            return;
          }
          reasons.push(`${host(endpoint.url)}: the answer was not a list of logs`);
          break;
        case "span": {
          const asked = Number(piece.to - piece.from + 1n);
          endpoint.maxSpan = Math.min(endpoint.maxSpan, outcome.limit && outcome.limit < asked ? outcome.limit : Math.floor(asked / 2));
          if (endpoint.maxSpan < MIN_USEFUL_SPAN) endpoint.disabled = true;
          reasons.push(outcome.message);
          next.push(piece);
          return;
        }
        case "addresses":
          endpoint.maxAddresses = Math.min(endpoint.maxAddresses, outcome.limit && outcome.limit > 0 ? outcome.limit : Math.max(1, Math.floor((piece.addresses?.length ?? 2) / 2)));
          reasons.push(outcome.message);
          next.push(piece);
          return;
        case "needs-address":
          endpoint.needsAddress = true;
          reasons.push(outcome.message);
          next.push(piece);
          return;
        case "unusable":
          endpoint.disabled = true;
          reasons.push(outcome.message);
          next.push(piece);
          return;
        case "retry":
        case "fatal":
          reasons.push(outcome.message);
          break;
      }
      if (piece.attempts + 1 >= giveUpAfter) throw new RpcUnavailableError("eth_getLogs", reasons);
      next.push({ ...piece, attempts: piece.attempts + 1 });
    };

    let queue: Piece[] = [{ from: query.fromBlock, to: query.toBlock, addresses, attempts: 0 }];
    for (let round = 0; queue.length > 0; round++) {
      if (round > 40) throw new RpcUnavailableError("eth_getLogs", [...reasons, "the range kept being refused"]);
      // A round after a refusal on every endpoint waits a little before the next try.
      if (round > 0 && queue.every((piece) => piece.attempts > 0 && piece.attempts % this.logs.length === 0)) await sleep(400);
      const next: Piece[] = [];
      // An endpoint that has not answered a log query yet gets one piece first: its limits are
      // learned from one refusal instead of from several sent at once.
      const first = queue.findIndex((piece) => {
        const endpoint = pick(piece);
        return endpoint !== null && !endpoint.proven && piece.to - piece.from + 1n <= BigInt(endpoint.maxSpan);
      });
      if (first >= 0 && queue.length > 1) {
        await settle(queue[first]!, next);
        queue = [...next, ...queue.filter((_, i) => i !== first)];
        continue;
      }
      await inPool(queue, this.concurrency, (piece) => settle(piece, next));
      queue = next;
    }
    return dedupe(found).filter((log) => log.removed !== true);
  }
}

/** Runs `task` over `items`, at most `limit` at a time. The first failure fails the whole. */
export async function inPool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  });
  await Promise.all(lanes);
}

function dedupe(logs: RawLog[]): RawLog[] {
  const seen = new Set<string>();
  const out: RawLog[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  return out.sort((a, b) => {
    const block = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    if (block !== 0n) return block < 0n ? -1 : 1;
    return Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
