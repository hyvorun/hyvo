// Many view calls in one eth_call, through Uniswap's UniswapInterfaceMulticall on Robinhood Chain. Each call has
// its own gas limit, so one contract that burns gas in a view cannot sink the batch. A check needs few requests
// this way, which matters inside a Cloudflare Worker (each request is a subrequest).

import { ADDRESSES } from "../registry/addresses.js";
import { decodeParameters } from "./abi-decode.js";
import { encodeParameters } from "./abi-encode.js";
import { type JsonRpcClient, RpcError } from "./rpc.js";

/** One read: call `data` on `target`. */
export interface Read {
  target: string;
  data: string;
}

// multicall((address target, uint256 gasLimit, bytes callData)[]) returns (uint256 blockNumber, (bool success, uint256 gasUsed, bytes returnData)[])
const MULTICALL_SELECTOR = "0x1749e1e3";
const CALLS = [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }];
const RESULTS = [
  { type: "uint256" },
  { type: "tuple[]", components: [{ type: "bool" }, { type: "uint256" }, { type: "bytes" }] },
];

const GAS_PER_READ = 1_000_000n;
const READS_PER_BATCH = 25; // 25 x 1M gas stays inside the 30M the batch is given
const BATCH_GAS = "0x1c9c380"; // 30,000,000

/**
 * Runs the reads at `block` and returns each one's return data, or null when that call reverted or returned
 * nothing (no code at the target, or a function the contract does not have). Throws when the batch itself could
 * not be run (an RpcError from the client).
 */
export async function multicall(rpc: JsonRpcClient, block: string, reads: readonly Read[]): Promise<(string | null)[]> {
  const batches: Read[][] = [];
  for (let i = 0; i < reads.length; i += READS_PER_BATCH) batches.push(reads.slice(i, i + READS_PER_BATCH));
  const answers = await Promise.all(batches.map((batch) => runBatch(rpc, block, batch)));
  return answers.flat();
}

async function runBatch(rpc: JsonRpcClient, block: string, reads: readonly Read[]): Promise<(string | null)[]> {
  if (reads.length === 0) return [];
  const args = encodeParameters(CALLS, [reads.map((r) => [r.target, GAS_PER_READ, r.data])]);
  const raw = await rpc.ethCall(
    { to: ADDRESSES.uniswapInterfaceMulticall.address, data: MULTICALL_SELECTOR + args.slice(2), gas: BATCH_GAS },
    block,
  );
  let results: [boolean, bigint, string][];
  try {
    [, results] = decodeParameters(RESULTS, raw) as [bigint, [boolean, bigint, string][]];
  } catch {
    throw new RpcError("the RPC's answer to a multicall could not be decoded", "rpc");
  }
  if (results.length !== reads.length) throw new RpcError("a multicall answered a different number of calls", "rpc");
  return results.map(([success, , data]) => (success && data.length > 2 ? data : null));
}
