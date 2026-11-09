// The two JSON-RPC reads `hyvo verify` makes: eth_chainId and one eth_call. Hyvo Check has its own client.

import { hostOf } from "./config.js";

export class RpcFailure extends Error {
  override readonly name = "RpcFailure";
}

export async function jsonRpc(fetchFn: typeof fetch, url: string, method: string, params: unknown[]): Promise<string> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new RpcFailure(`${hostOf(url)} answered HTTP ${response.status} to ${method}`);
  let body: { result?: unknown; error?: { message?: unknown } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new RpcFailure(`${hostOf(url)} did not answer ${method} with JSON`);
  }
  if (body.error) throw new RpcFailure(`${hostOf(url)} refused ${method}: ${String(body.error.message ?? "no reason given").slice(0, 200)}`);
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.result)) throw new RpcFailure(`${hostOf(url)} gave no result for ${method}`);
  return body.result;
}
