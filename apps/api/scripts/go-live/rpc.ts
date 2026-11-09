/**
 * Plain JSON-RPC reads over the public Robinhood Chain endpoints in apps/api/production.vars.json (RPC_URLS),
 * tried in order. Only reads: nothing here signs or sends a transaction.
 */
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem";

export type FetchLike = (
  url: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The chain answered that the call reverted: an answer, not an outage, so the next endpoint is not asked. */
export class CallReverted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallReverted";
  }
}

export interface RpcRequest {
  method: string;
  params: unknown[];
}

interface RpcBody {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isRevert(error: { code?: number; message?: string }): boolean {
  return error.code === 3 || /revert/i.test(error.message ?? "");
}

export class Rpc {
  /** The endpoint that answered last, for the report. */
  lastHost = "";

  constructor(
    readonly urls: readonly string[],
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 20_000,
  ) {
    if (urls.length === 0) throw new Error("no RPC endpoint: RPC_URLS in apps/api/production.vars.json is empty");
  }

  async request<T>(method: string, params: unknown[]): Promise<T> {
    const reasons: string[] = [];
    for (const url of this.urls) {
      let body: RpcBody;
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          reasons.push(`${host(url)}: HTTP ${response.status}`);
          continue;
        }
        body = (await response.json()) as RpcBody;
      } catch (error) {
        reasons.push(`${host(url)}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (body.error) {
        if (method === "eth_call" && isRevert(body.error)) throw new CallReverted(body.error.message ?? "execution reverted");
        reasons.push(`${host(url)}: ${body.error.message ?? `error ${body.error.code}`}`);
        continue;
      }
      this.lastHost = host(url);
      return body.result as T;
    }
    throw new Error(`no RPC endpoint answered ${method} (${reasons.join("; ")})`);
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.request<Hex>("eth_chainId", [])));
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.request<Hex>("eth_blockNumber", []));
  }

  async code(address: Address, block: bigint): Promise<Hex> {
    return this.request<Hex>("eth_getCode", [address, toHex(block)]);
  }

  /** A view call decoded with `abi`; a revert or an answer that does not decode is `null`. */
  async read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[], block: bigint): Promise<T | null> {
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    let result: Hex;
    try {
      result = await this.request<Hex>("eth_call", [{ to: address, data }, toHex(block)]);
    } catch (error) {
      if (error instanceof CallReverted) return null;
      throw error;
    }
    if (!result || result === "0x") return null;
    try {
      return decodeFunctionResult({ abi, functionName, data: result } as Parameters<typeof decodeFunctionResult>[0]) as T;
    } catch {
      return null;
    }
  }
}

export function toHex(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}
