import { decodeUint } from "./abi.js";
import type { JsonRpcClient } from "./rpc.js";

// An unused address to override in the probe. Not a precompile.
const PROBE_ADDRESS = "0x1111111111111111111111111111111111111111";

// Runtime bytecode that returns uint256(42):
//   PUSH1 0x2a, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN
const PROBE_CODE = "0x602a60005260206000f3";

/**
 * Whether the RPC honors state overrides in eth_call. The exit simulation depends on them; where they are not
 * honored, the simulation reports "skipped" with this as the reason, never a result. dRPC and PublicNode
 * honored them on Robinhood Chain on 2026-11-09.
 */
export async function supportsStateOverride(rpc: JsonRpcClient, block = "latest"): Promise<boolean> {
  try {
    const res = await rpc.ethCall({ to: PROBE_ADDRESS, data: "0x" }, block, {
      [PROBE_ADDRESS]: { code: PROBE_CODE },
    });
    return decodeUint(res) === 42n;
  } catch {
    return false;
  }
}
