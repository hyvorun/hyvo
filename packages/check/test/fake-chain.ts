// A fake Robinhood Chain for tests: a JSON-RPC server that answers the multicall batches call by call, the
// probe's eth_call with a scripted result, and a fake Sourcify. No network. Shared by check.test.ts and any test
// that runs the package in another runtime (such as workerd).
import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
} from "viem";
import { expect } from "vitest";
import type { FetchLike } from "../src/index";
import probe from "../src/probe/sellcheck.json" with { type: "json" };
import { ADDRESSES, PROBE_ADDRESS } from "../src/registry/addresses";

export const TOKEN = getAddress("0x8eee67a8aad993f15b4506975b38c52f6d3ce758");
export const OWNER = getAddress("0xabc9000000000000000000000000000000000f21");
export const PAIR = getAddress("0xdb661ec4d1ba1d9ad9d2a6cd92fce25a8f08ad25");
const V2F = getAddress("0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f");
const V3F = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
const HOOK = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");
const PM = ADDRESSES.uniswapV4PoolManager.address;
const WETH = ADDRESSES.weth.address;
const MULTICALL = ADDRESSES.uniswapInterfaceMulticall.address;

const MULTICALL_ABI = parseAbi([
  "struct Call { address target; uint256 gasLimit; bytes callData; }",
  "struct Result { bool success; uint256 gasUsed; bytes returnData; }",
  "function multicall(Call[] calls) returns (uint256 blockNumber, Result[] returnData)",
]);

const sel = (sig: string) => toFunctionSelector(sig);
const word = (v: bigint | number) => encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(v)]);
const addr = (a: string) => encodeAbiParameters(parseAbiParameters("address"), [a as Address]);
const str = (s: string) => encodeAbiParameters(parseAbiParameters("string"), [s]);
const zeros = (n: number) => `0x${"0".repeat(64 * n)}` as const;
const push4 = (sig: string) => `63${sel(sig).slice(2)}`;

type Answer = string | null; // null: the call reverts
export type Scenario = {
  chainId?: string;
  code?: string;
  /** Answers for view calls inside a multicall, by target and calldata. */
  view?: (target: string, data: string) => Answer | undefined;
  probeResult?: Record<string, unknown> | "empty";
  sourcify?: { status: number; body: unknown };
};

const SELLCHECK_V2 = probe.abi.find((x) => x.type === "function" && x.name === "checkV2")!;

function defaultView(target: string, data: string): Answer | undefined {
  const t = target.toLowerCase();
  const s = data.slice(0, 10);
  if (t === TOKEN.toLowerCase()) {
    if (s === sel("name()")) return str("Test Token");
    if (s === sel("symbol()")) return str("TT");
    if (s === sel("decimals()")) return word(18);
    if (s === sel("totalSupply()")) return word(10n ** 27n);
    if (s === sel("owner()")) return addr(OWNER);
    if (s === sel("getOwner()")) return null;
    if (s === sel("balanceOf(address)")) return word(0);
  }
  if (s === sel("getLaunchedToken(address)")) return t === ADDRESSES.ponsV2Factory.address.toLowerCase() ? zeros(15) : zeros(13);
  if (t === ADDRESSES.uniswapV2Router02.address.toLowerCase() && s === sel("factory()")) return addr(V2F);
  if (t === ADDRESSES.uniswapV3SwapRouter02.address.toLowerCase() && s === sel("factory()")) return addr(V3F);
  if (s === sel("memeHook()")) return addr(HOOK);
  if (s === sel("poolManager()")) return addr(PM);
  if (t === V2F.toLowerCase() && s === sel("getPair(address,address)")) return addr(PAIR);
  if (t === V3F.toLowerCase() && s === sel("getPool(address,address,uint24)")) return addr("0x0000000000000000000000000000000000000000");
  if (t === PAIR.toLowerCase() && s === sel("getReserves()")) return encodeAbiParameters(parseAbiParameters("uint112, uint112, uint32"), [649_000_000_000_000_000n, 2n * 10n ** 26n, 1]);
  if (t === PAIR.toLowerCase() && s === sel("token0()")) return addr(WETH);
  return undefined;
}

export const PLAIN_RESULT = {
  buyOk: true,
  expectedBuy: 306_170n * 10n ** 18n,
  gotBuy: 306_170n * 10n ** 18n,
  buyGas: 133_547n,
  buyErr: "0x",
  transferOk: true,
  transferSent: 30_617n * 10n ** 18n,
  transferArrived: 30_617n * 10n ** 18n,
  transferErr: "0x",
  approveOk: true,
  sellIn: 275_553n * 10n ** 18n,
  expectedSell: 894_000_000_000_000n,
  sellOk: true,
  gotSell: 894_000_000_000_000n,
  sellGas: 70_281n,
  sellErr: "0x",
};

export function fakeChain(scenario: Scenario = {}) {
  const calls: { url: string; method?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    calls.push({ url });
    if (url.startsWith("https://sourcify.test/")) {
      const s = scenario.sourcify ?? {
        status: 200,
        body: {
          match: "exact_match",
          abi: [{ type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" }],
          deployment: { deployer: OWNER, transactionHash: `0x${"ab".repeat(32)}`, blockNumber: "26841846" },
          verifiedAt: "2026-08-04T17:40:43Z",
        },
      };
      return respond(s.status, s.body);
    }
    if (url.startsWith("https://down.test")) return respond(503, { error: "down" });
    const req = JSON.parse(init.body ?? "{}") as { id: number; method: string; params: unknown[] };
    calls[calls.length - 1]!.method = req.method;
    const ok = (result: unknown) => respond(200, { jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "eth_chainId":
        return ok(scenario.chainId ?? "0x1237");
      case "eth_blockNumber":
        return ok("0x100");
      case "eth_getCode":
        return ok(scenario.code ?? `0x6080604052${push4("mint(address,uint256)")}1461`);
      case "eth_getStorageAt":
        return ok(zeros(1));
      case "eth_call": {
        const [tx, block, override] = req.params as [{ to: string; data: string }, string, Record<string, { code?: string }>?];
        expect(block).toBe("0xfe"); // two blocks below the head
        if (tx.to.toLowerCase() === MULTICALL.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: MULTICALL_ABI, data: tx.data as `0x${string}` });
          const results = (args[0] as readonly { target: string; callData: string }[]).map((c) => {
            const custom = scenario.view?.(c.target, c.callData);
            const answer = custom === undefined ? defaultView(c.target, c.callData) : custom;
            return answer === null || answer === undefined
              ? { success: false, gasUsed: 0n, returnData: "0x" as const }
              : { success: true, gasUsed: 1000n, returnData: answer as `0x${string}` };
          });
          return ok(encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "multicall", result: [254n, results] }));
        }
        if (tx.to.toLowerCase() === PROBE_ADDRESS.toLowerCase()) {
          expect(override?.[PROBE_ADDRESS]?.code).toBe(probe.runtimeBytecode);
          if (scenario.probeResult === "empty") return ok("0x");
          return ok(encodeAbiParameters(SELLCHECK_V2.outputs as never, [scenario.probeResult ?? PLAIN_RESULT] as never));
        }
        if (tx.to === "0x1111111111111111111111111111111111111111") return ok("0x"); // the state-override capability probe
        return respond(200, { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted" } });
      }
    }
    return respond(200, { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
  };
  return { fetch, calls };
}

export const OPTIONS = { rpcUrls: ["https://rpc.test"], sourcifyUrl: "https://sourcify.test/server" };
