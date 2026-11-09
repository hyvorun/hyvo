/**
 * A stubbed Robinhood Chain for Hyvo Check's browser tests. The JSON-RPC endpoint (http://rpc.test, the
 * app's VITE_RPC_URLS in playwright.config.ts) answers the reads @hyvo/check batches through
 * UniswapInterfaceMulticall, call by call, and the exit simulation's eth_call with a scripted probe
 * result. Sourcify answers from the scenario. Nothing reaches a network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADDRESSES, PROBE_ADDRESS } from "@hyvo/check";
import type { Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";

// The probe's ABI, as the package exports it, so the scripted results keep its exact shape.
const probe = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../packages/check/src/probe/sellcheck.json", import.meta.url)), "utf8"),
) as { abi: Abi };
const PROBE_OUTPUTS = (probe.abi.find((item) => item.type === "function" && item.name === "checkV2") as { outputs: readonly unknown[] }).outputs;

export const TOKEN = getAddress("0x8eee67a8aad993f15b4506975b38c52f6d3ce758");
export const OWNER = getAddress("0xabc9000000000000000000000000000000000f21");
export const PAIR = getAddress("0xdb661ec4d1ba1d9ad9d2a6cd92fce25a8f08ad25");
const V2_FACTORY = getAddress("0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f");
const V3_FACTORY = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
const HOOK = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");
const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = ADDRESSES.weth.address;
const POOL_MANAGER = ADDRESSES.uniswapV4PoolManager.address;
const MULTICALL = ADDRESSES.uniswapInterfaceMulticall.address;

/** eth_blockNumber answers 0x100, and the check reads two blocks below: 254. */
export const BLOCK = 254;

const MULTICALL_ABI = parseAbi([
  "struct Call { address target; uint256 gasLimit; bytes callData; }",
  "struct Result { bool success; uint256 gasUsed; bytes returnData; }",
  "function multicall(Call[] calls) returns (uint256 blockNumber, Result[] returnData)",
]);

const selector = (signature: string) => toFunctionSelector(signature);
const word = (value: bigint | number) => encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(value)]);
const address = (value: string) => encodeAbiParameters(parseAbiParameters("address"), [value as Address]);
const text = (value: string) => encodeAbiParameters(parseAbiParameters("string"), [value]);
const zeros = (words: number) => `0x${"0".repeat(64 * words)}` as Hex;
const push4 = (signature: string) => `63${selector(signature).slice(2)}`;

/** Revert data for Error(string), as a token or a router reverts with it. */
export function errorString(message: string): Hex {
  return `0x08c379a0${text(message).slice(2)}`;
}

/** The probe's result struct. Amounts in the token's and ETH's smallest units. */
export interface ProbeResult {
  buyOk: boolean;
  expectedBuy: bigint;
  gotBuy: bigint;
  buyGas: bigint;
  buyErr: Hex;
  transferOk: boolean;
  transferSent: bigint;
  transferArrived: bigint;
  transferErr: Hex;
  approveOk: boolean;
  sellIn: bigint;
  expectedSell: bigint;
  sellOk: boolean;
  gotSell: bigint;
  sellGas: bigint;
  sellErr: Hex;
}

const E18 = 10n ** 18n;

/** A token that arrives in full at every step. */
export const PLAIN: ProbeResult = {
  buyOk: true,
  expectedBuy: 306_170n * E18,
  gotBuy: 306_170n * E18,
  buyGas: 133_547n,
  buyErr: "0x",
  transferOk: true,
  transferSent: 30_617n * E18,
  transferArrived: 30_617n * E18,
  transferErr: "0x",
  approveOk: true,
  sellIn: 275_553n * E18,
  expectedSell: 894_000_000_000_000n,
  sellOk: true,
  gotSell: 894_000_000_000_000n,
  sellGas: 70_281n,
  sellErr: "0x",
};

/** A token that keeps 5% of every buy, transfer and sell. */
export const TAXED: ProbeResult = {
  ...PLAIN,
  gotBuy: (PLAIN.expectedBuy * 95n) / 100n,
  transferSent: 29_086_150n * 10n ** 15n,
  transferArrived: 27_631_842_500n * 10n ** 12n,
  sellIn: 261_775_350n * 10n ** 15n,
  expectedSell: 850_000_000_000_000n,
  gotSell: 807_500_000_000_000n,
};

/** A token that buys and sends normally and refuses the sell into its pair. */
export const SELL_REVERTS: ProbeResult = {
  ...PLAIN,
  sellOk: false,
  gotSell: 0n,
  sellErr: errorString("TransferHelper: TRANSFER_FROM_FAILED"),
};

export interface CheckScenario {
  name?: string;
  symbol?: string;
  /** Where the token trades: a Uniswap V2 pair with WETH that holds reserves, or nowhere. */
  venue?: "v2" | "none";
  probe?: ProbeResult;
  /** Sourcify's answer for the token: a verified ABI with a fee setter, or not verified. */
  sourcify?: "verified" | "none";
}

export interface CheckLog {
  rpc: string[];
  sourcify: number;
}

type Answer = Hex | null; // null: the call reverts

function view(scenario: CheckScenario, target: string, data: string): Answer {
  const to = target.toLowerCase();
  const sel = data.slice(0, 10);
  if (to === TOKEN.toLowerCase()) {
    if (sel === selector("name()")) return text(scenario.name ?? "Taxed Token");
    if (sel === selector("symbol()")) return text(scenario.symbol ?? "TAX");
    if (sel === selector("decimals()")) return word(18);
    if (sel === selector("totalSupply()")) return word(10n ** 27n);
    if (sel === selector("owner()")) return address(OWNER);
    if (sel === selector("balanceOf(address)")) return word(0);
    return null;
  }
  if (sel === selector("getLaunchedToken(address)")) return to === ADDRESSES.ponsV2Factory.address.toLowerCase() ? zeros(15) : zeros(13);
  if (to === ADDRESSES.uniswapV2Router02.address.toLowerCase() && sel === selector("factory()")) return address(V2_FACTORY);
  if (to === ADDRESSES.uniswapV3SwapRouter02.address.toLowerCase() && sel === selector("factory()")) return address(V3_FACTORY);
  if (sel === selector("memeHook()")) return address(HOOK);
  if (sel === selector("poolManager()")) return address(POOL_MANAGER);
  if (to === V2_FACTORY.toLowerCase() && sel === selector("getPair(address,address)")) return address(scenario.venue === "none" ? ZERO : PAIR);
  if (to === V3_FACTORY.toLowerCase() && sel === selector("getPool(address,address,uint24)")) return address(ZERO);
  if (to === PAIR.toLowerCase() && sel === selector("getReserves()")) {
    return encodeAbiParameters(parseAbiParameters("uint112, uint112, uint32"), [649n * 10n ** 15n, 2n * 10n ** 26n, 1]);
  }
  if (to === PAIR.toLowerCase() && sel === selector("token0()")) return address(WETH);
  return null;
}

function rpc(scenario: CheckScenario, method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x1237";
    case "eth_blockNumber":
      return "0x100";
    case "eth_getCode":
      // A dispatcher that holds owner() and setTaxes(uint256,uint256).
      return `0x6080604052${push4("owner()")}1461${push4("setTaxes(uint256,uint256)")}1461`;
    case "eth_getStorageAt":
      return zeros(1);
    case "eth_call": {
      const [tx] = params as [{ to: string; data: Hex }];
      if (tx.to.toLowerCase() === MULTICALL.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: MULTICALL_ABI, data: tx.data });
        const results = (args[0] as readonly { target: string; callData: Hex }[]).map((call) => {
          const answer = view(scenario, call.target, call.callData);
          return answer === null ? { success: false, gasUsed: 0n, returnData: "0x" as Hex } : { success: true, gasUsed: 1000n, returnData: answer };
        });
        return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "multicall", result: [BigInt(BLOCK), results] });
      }
      if (tx.to.toLowerCase() === PROBE_ADDRESS.toLowerCase()) {
        return encodeAbiParameters(PROBE_OUTPUTS as never, [scenario.probe ?? PLAIN] as never);
      }
      throw Object.assign(new Error("execution reverted"), { code: 3 });
    }
    default:
      throw new Error(`the stub chain does not answer ${method}`);
  }
}

const SOURCIFY_VERIFIED = {
  match: "exact_match",
  abi: [
    { type: "function", name: "owner", inputs: [], stateMutability: "view" },
    { type: "function", name: "setTaxes", inputs: [{ type: "uint256" }, { type: "uint256" }], stateMutability: "nonpayable" },
  ],
  deployment: { deployer: OWNER, transactionHash: `0x${"ab".repeat(32)}`, blockNumber: "26841846" },
  verifiedAt: "2026-08-04T17:40:43Z",
};

/** Serve Robinhood Chain at http://rpc.test and Sourcify for one check scenario; returns what was asked. */
export async function stubCheck(page: Page, scenario: CheckScenario = {}): Promise<CheckLog> {
  const log: CheckLog = { rpc: [], sourcify: 0 };
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST",
  };
  await page.route("http://rpc.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const request = JSON.parse(route.request().postData() ?? "{}") as { id: number; method: string; params?: unknown[] };
    log.rpc.push(request.method);
    let body: unknown;
    try {
      body = { jsonrpc: "2.0", id: request.id, result: rpc(scenario, request.method, request.params ?? []) };
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32601;
      body = { jsonrpc: "2.0", id: request.id, error: { code, message: (error as Error).message } };
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
  });
  await page.route("https://sourcify.dev/server/**", async (route) => {
    log.sourcify++;
    const verified = scenario.sourcify === "verified" && route.request().url().toLowerCase().includes(TOKEN.toLowerCase());
    return route.fulfill({
      status: verified ? 200 : 404,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(verified ? SOURCIFY_VERIFIED : { match: null, chainId: "4663", address: TOKEN }),
    });
  });
  return log;
}
