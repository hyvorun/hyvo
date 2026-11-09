// Minimal JSON-RPC client over fetch. No dependencies. Read-only by construction: it only knows the methods
// below, none of which signs or sends anything.
//
// Endpoints are tried in order. A transport failure (timeout, network error, HTTP error, an RPC error such as a
// node that lacks the state) moves on to the next endpoint, and the whole list is tried twice, or until `attempts`
// requests were sent for the call. A revert is an answer, not a failure, so it is thrown at once as an RpcError of
// kind "revert".

import { HttpError, hostOf, type Net, sleep } from "../net.js";

export type CallTx = {
  to: string;
  data: string;
  from?: string;
  value?: string;
  gas?: string;
};

/** A single address's overridden state for eth_call (Geth shape). */
export type StateOverride = Record<string, { code?: string; balance?: string; nonce?: string }>;

export type RpcErrorKind = "revert" | "rpc" | "http" | "timeout" | "aborted" | "network";

export class RpcError extends Error {
  override readonly name = "RpcError";

  constructor(
    message: string,
    readonly kind: RpcErrorKind,
    readonly code?: number,
    /** Revert data, when the node returned it. */
    readonly data?: string,
  ) {
    super(message);
  }
}

type RpcResponse = { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

function isRevert(code: number | undefined, message: string): boolean {
  return code === 3 || /revert/i.test(message);
}

const READ_ONLY_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]);

export class JsonRpcClient {
  private id = 0;

  constructor(
    private readonly net: Net,
    private readonly urls: readonly string[],
    /** Requests sent for one call at most, across the URLs; default every URL twice. */
    private readonly attempts = urls.length * 2,
  ) {
    if (urls.length === 0) throw new Error("at least one RPC URL is needed");
    if (!Number.isInteger(attempts) || attempts < 1) throw new Error("attempts must be a whole number of at least 1");
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`not a read-only method: ${method}`);
    let last: RpcError | undefined;
    let sent = 0;
    for (let round = 0; round < 2 && sent < this.attempts; round++) {
      if (round > 0) await sleep(300);
      for (const url of this.urls) {
        if (sent >= this.attempts) break;
        sent++;
        try {
          return (await this.once(url, method, params)) as T;
        } catch (error) {
          const err = toRpcError(error);
          if (err.kind === "revert" || err.kind === "aborted") throw err;
          last = err;
        }
      }
    }
    throw last ?? new RpcError(`${method} failed`, "rpc");
  }

  private async once(url: string, method: string, params: unknown[]): Promise<unknown> {
    const res = await this.net.request("rpc", url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    let json: RpcResponse;
    try {
      json = JSON.parse(res.text) as RpcResponse;
    } catch {
      throw new RpcError(`${hostOf(url)} answered HTTP ${res.status} without JSON on ${method}`, "http", res.status);
    }
    if (json && typeof json === "object" && json.error) {
      const message = String(json.error.message ?? "");
      const code = typeof json.error.code === "number" ? json.error.code : undefined;
      if (isRevert(code, message)) {
        const data = typeof json.error.data === "string" ? json.error.data : undefined;
        throw new RpcError(`execution reverted on ${method}`, "revert", code, data);
      }
      throw new RpcError(`RPC error ${code ?? "?"} on ${method} from ${hostOf(url)}: ${message.slice(0, 160)}`, "rpc", code);
    }
    if (!res.ok) throw new RpcError(`${hostOf(url)} answered HTTP ${res.status} on ${method}`, "http", res.status);
    if (!json || typeof json !== "object" || json.result === undefined || json.result === null) {
      throw new RpcError(`no result on ${method} from ${hostOf(url)}`, "rpc");
    }
    return json.result;
  }

  chainId(): Promise<string> {
    return this.call("eth_chainId", []);
  }

  blockNumber(): Promise<string> {
    return this.call("eth_blockNumber", []);
  }

  getCode(address: string, block: string): Promise<string> {
    return this.call("eth_getCode", [address, block]);
  }

  getStorageAt(address: string, slot: string, block: string): Promise<string> {
    return this.call("eth_getStorageAt", [address, slot, block]);
  }

  /** eth_call, with an optional state override (third parameter). */
  ethCall(tx: CallTx, block: string, stateOverride?: StateOverride): Promise<string> {
    const params: unknown[] = [tx, block];
    if (stateOverride) params.push(stateOverride);
    return this.call("eth_call", params);
  }
}

export function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof HttpError) return new RpcError(error.message, error.kind, error.status);
  return new RpcError(error instanceof Error ? error.message : String(error), "network");
}

export function toBlockTag(block: bigint): string {
  return `0x${block.toString(16)}`;
}
