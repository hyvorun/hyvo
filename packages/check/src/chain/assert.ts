import { decodeUint } from "./abi.js";
import type { JsonRpcClient } from "./rpc.js";

/** The chain an RPC answers for, from eth_chainId. */
export async function readChainId(rpc: JsonRpcClient): Promise<number> {
  return Number(decodeUint(await rpc.chainId()));
}

/**
 * The RPC could point at any chain. Confirm it is the one expected before trusting its answers.
 * Throws when it is not.
 */
export async function assertChainId(rpc: JsonRpcClient, expected: number): Promise<void> {
  const actual = await readChainId(rpc);
  if (actual !== expected) {
    throw new Error(`chain mismatch: the RPC reports chain ID ${actual}, expected ${expected}`);
  }
}
