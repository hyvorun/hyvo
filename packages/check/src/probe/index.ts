// The SellCheck probe (chain/src/probes/SellCheck.sol), as exported from Foundry's build by
// chain/scripts/export-probe.mjs. It is never deployed: an eth_call places this runtime code at PROBE_ADDRESS
// through a state override. test/probe.test.ts checks that the export matches the Solidity source and, where
// the build output exists, forge's bytecode.

import type { AbiFunction } from "../chain/abi-decode.js";
import { decodeFunctionOutput, encodeFunctionCall } from "../chain/abi-decode.js";
import type { Hex } from "../types.js";
import sellcheck from "./sellcheck.json" with { type: "json" };

export const PROBE_RUNTIME = sellcheck.runtimeBytecode as Hex;
export const PROBE_SOURCE_SHA256: string = sellcheck.sourceSha256;
export const PROBE_COMPILER: string | null = sellcheck.compiler;

const FUNCTIONS = (sellcheck.abi as unknown as { type: string }[]).filter(
  (item): item is AbiFunction => item.type === "function",
);

export type ProbeFunction = "checkV2" | "checkPonsCurve" | "checkV3" | "checkV4";

function probeFunction(name: ProbeFunction): AbiFunction {
  const item = FUNCTIONS.find((f) => f.name === name);
  if (!item) throw new Error(`the exported probe has no ${name}`);
  return item;
}

/** What one round trip did, as the probe's Result struct. Amounts are raw integers. */
export interface ProbeResult {
  buyOk: boolean;
  expectedBuy: bigint;
  gotBuy: bigint;
  buyGas: bigint;
  buyErr: string;
  transferOk: boolean;
  transferSent: bigint;
  transferArrived: bigint;
  transferErr: string;
  approveOk: boolean;
  sellIn: bigint;
  expectedSell: bigint;
  sellOk: boolean;
  gotSell: bigint;
  sellGas: bigint;
  sellErr: string;
}

export function encodeProbeCall(name: ProbeFunction, args: readonly unknown[]): Hex {
  return encodeFunctionCall(probeFunction(name), args);
}

export function decodeProbeResult(name: ProbeFunction, data: string): ProbeResult {
  const [result] = decodeFunctionOutput(probeFunction(name), data) as [ProbeResult];
  return result;
}
