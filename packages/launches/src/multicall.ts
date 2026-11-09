/**
 * Many contract reads in one eth_call, through Multicall3's aggregate3 with every call allowed to
 * fail on its own. Each batch also asks ArbSys for the Robinhood Chain block and Multicall3 for the
 * block's time, so every answer says exactly which block it describes.
 */
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { ARBSYS, ARBSYS_ABI, MULTICALL3, MULTICALL3_ABI } from "./pons";
import { inPool, type ChainReader } from "./rpc";

export interface Read {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ReadResult = { ok: true; value: unknown } | { ok: false };

export interface MulticallAnswer {
  results: ReadResult[];
  /** The Robinhood Chain block the reads describe (the oldest, if batches landed on different blocks). */
  block: bigint;
  /** Its time, in seconds. */
  timestamp: number;
}

/** Calls per eth_call: small enough for a node's gas cap and a quick answer. */
export const BATCH = 300;

export async function multicall(reader: ChainReader, reads: readonly Read[], options: { concurrency?: number } = {}): Promise<MulticallAnswer> {
  const batches: Read[][] = [];
  for (let i = 0; i < Math.max(1, reads.length); i += BATCH) batches.push(reads.slice(i, i + BATCH));
  const answers: { results: ReadResult[]; block: bigint; timestamp: number }[] = new Array(batches.length);
  await inPool(
    batches.map((batch, index) => ({ batch, index })),
    options.concurrency ?? 3,
    async ({ batch, index }) => {
      answers[index] = await aggregate(reader, batch);
    },
  );
  let block: bigint | null = null;
  let timestamp = 0;
  const results: ReadResult[] = [];
  for (const answer of answers) {
    results.push(...answer.results);
    if (block === null || answer.block < block) {
      block = answer.block;
      timestamp = answer.timestamp;
    }
  }
  return { results: results.slice(0, reads.length), block: block ?? 0n, timestamp };
}

async function aggregate(reader: ChainReader, reads: readonly Read[]) {
  const calls = [
    { target: ARBSYS, allowFailure: true, callData: encodeFunctionData({ abi: ARBSYS_ABI, functionName: "arbBlockNumber" }) },
    { target: MULTICALL3, allowFailure: true, callData: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp" }) },
    ...reads.map((read) => ({
      target: read.address,
      allowFailure: true,
      callData: encodeFunctionData({ abi: read.abi, functionName: read.functionName, args: read.args ?? [] } as Parameters<typeof encodeFunctionData>[0]),
    })),
  ];
  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "aggregate3", args: [calls] });
  const raw = await reader.ethCall(MULTICALL3, data);
  const decoded = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: raw }) as readonly { success: boolean; returnData: Hex }[];
  if (decoded.length !== calls.length) throw new Error(`Multicall3 answered ${decoded.length} of ${calls.length} calls`);
  const [blockAnswer, timeAnswer, ...rest] = decoded;
  const block = blockAnswer?.success ? (decodeFunctionResult({ abi: ARBSYS_ABI, functionName: "arbBlockNumber", data: blockAnswer.returnData }) as bigint) : 0n;
  const timestamp = timeAnswer?.success
    ? Number(decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp", data: timeAnswer.returnData }) as bigint)
    : 0;
  const results = rest.map((answer, i): ReadResult => {
    const read = reads[i]!;
    if (!answer.success || answer.returnData === "0x") return { ok: false };
    try {
      return { ok: true, value: decodeFunctionResult({ abi: read.abi, functionName: read.functionName, data: answer.returnData } as Parameters<typeof decodeFunctionResult>[0]) };
    } catch {
      return { ok: false };
    }
  });
  return { results, block, timestamp };
}
