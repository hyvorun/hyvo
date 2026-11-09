/**
 * A small JSON-RPC client for the scripts: a few requests at a time, retried with a growing pause.
 * dRPC's free tier serves old state on some nodes and not on others ("Unknown state", code 27;
 * docs/OPEN_ITEMS.md item 25), so a read of the past is simply asked again until a node has it.
 */
export const DEFAULT_RPC = "https://robinhood.drpc.org";

export interface RpcClient {
  request<T>(method: string, params: unknown[]): Promise<T>;
  readonly calls: number;
}

export function rpcClient(url = process.env.RH_RPC_URL || DEFAULT_RPC, { concurrency = 6, attempts = 40 } = {}): RpcClient {
  let active = 0;
  let calls = 0;
  const waiting: (() => void)[] = [];

  async function once<T>(method: string, params: unknown[]): Promise<T> {
    let last = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      calls++;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
          signal: AbortSignal.timeout(25_000),
        });
        const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
        if (body.error === undefined && "result" in body) return body.result as T;
        last = JSON.stringify(body.error ?? response.status);
        // A revert is an answer, not a busy node: asking again would get the same.
        if (body.error?.code === 3 || /execution reverted/i.test(body.error?.message ?? "")) throw new RevertError(last);
      } catch (error) {
        if (error instanceof RevertError) throw error;
        last = String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(6_000, 400 + attempt * 350)));
    }
    throw new Error(`${method} failed ${attempts} times: ${last.slice(0, 200)}`);
  }

  return {
    get calls() {
      return calls;
    },
    async request<T>(method: string, params: unknown[]): Promise<T> {
      if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await once<T>(method, params);
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
}

export class RevertError extends Error {}

export const hex = (n: number | bigint) => `0x${n.toString(16)}`;
