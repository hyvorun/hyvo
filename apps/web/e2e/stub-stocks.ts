/**
 * A stubbed Robinhood Chain for the stock pages: the JSON-RPC endpoint at http://rpc.test answers
 * the reads @hyvo/stocks makes (blocks, code, the beacon slot, the factory's nonce, and Multicall3
 * calls into the tokens, the factory, the registry and a Chainlink feed), and Chainlink's feed
 * directory answers with the entries recorded in packages/stocks/test/fixtures.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BEACON_SLOT,
  FACTORY_ABI,
  FEED_ABI,
  FEED_DIRECTORY_URL,
  MULTICALL3,
  REGISTRY_ABI,
  SNAPSHOT,
  STOCK_ABI,
  STOCK_FACTORY,
  STOCK_IMPLEMENTATION,
  STOCK_REGISTRY,
} from "@hyvo/stocks";
import type { Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  pad,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const nvdaListed = SNAPSHOT.tokens.find((token) => token.symbol === "NVDA")!;

export const NVDA = nvdaListed.address;
/** A contract that copies NVDA's name, ticker and uid. The factory does not record it. */
export const LOOKALIKE: Address = getAddress("0x00000000000000000000000000000000000beef1");
export const NVDA_FEED: Address = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15";
/** Monday 9 November 2026, 15:00 UTC: regular trading in New York. */
export const BLOCK_TIME = 1_794_236_400;
export const BLOCK = 109_900_000n;

export interface StockToken {
  uid: Hex;
  name: string;
  symbol: string;
  uiMultiplier: bigint;
  newUIMultiplier: bigint;
  effectiveAt: bigint;
  paused: boolean;
  tokenPaused: boolean;
  oraclePaused: boolean;
}

export interface StockChain {
  tokens: Map<string, StockToken>;
  /** The factory's record: uid to token. */
  records: Map<string, Address>;
  registryPaused: boolean;
  factoryNonce: number;
  feed: { answer: bigint; updatedAt: number };
}

export function stockChain(change: (chain: StockChain) => void = () => {}): StockChain {
  const nvda: StockToken = {
    uid: nvdaListed.uid,
    name: "NVIDIA • Robinhood Token",
    symbol: "NVDA",
    uiMultiplier: 1000775159164630595n,
    newUIMultiplier: 1000775159164630595n,
    effectiveAt: 1_788_998_430n,
    paused: false,
    tokenPaused: false,
    oraclePaused: false,
  };
  const chain: StockChain = {
    tokens: new Map([
      [NVDA.toLowerCase(), nvda],
      [LOOKALIKE.toLowerCase(), { ...nvda }],
    ]),
    records: new Map([[nvda.uid.toLowerCase(), NVDA]]),
    registryPaused: false,
    factoryNonce: SNAPSHOT.factoryNonce,
    feed: { answer: 17_636_673_622n, updatedAt: BLOCK_TIME - 600 },
  };
  change(chain);
  return chain;
}

type Answer = { ok: true; data: Hex } | { ok: false };

function respond(abi: Abi, data: Hex, values: (name: string, args: readonly unknown[]) => unknown): Answer {
  try {
    const call = decodeFunctionData({ abi, data });
    const result = values(call.functionName, call.args ?? []);
    if (result === undefined) return { ok: false };
    return { ok: true, data: encodeFunctionResult({ abi, functionName: call.functionName, result } as never) };
  } catch {
    return { ok: false };
  }
}

function answer(chain: StockChain, to: string, data: Hex): Answer {
  const target = to.toLowerCase();
  const token = chain.tokens.get(target);
  if (token) {
    return respond(STOCK_ABI as Abi, data, (name, args) => {
      switch (name) {
        case "uid":
          return token.uid;
        case "name":
          return token.name;
        case "symbol":
          return token.symbol;
        case "decimals":
          return 18;
        case "totalSupply":
          return 94_544_568_281_770_000_000_000n;
        case "totalSupplyUI":
          return (94_544_568_281_770_000_000_000n * token.uiMultiplier) / 10n ** 18n;
        case "uiMultiplier":
          return token.uiMultiplier;
        case "newUIMultiplier":
          return token.newUIMultiplier;
        case "effectiveAt":
          return token.effectiveAt;
        case "paused":
          return token.paused || chain.registryPaused;
        case "tokenPaused":
          return token.tokenPaused;
        case "oraclePaused":
          return token.oraclePaused;
        case "ACCESS_CONTROLLED_REGISTRY":
          return STOCK_REGISTRY;
        case "terms":
          return "https://robinhood.com/stocktoken/rhj";
        case "supportsInterface":
          return ["0xa60bf13d", "0x4bd27648", "0xd890fd71"].includes(String(args[0]));
        default:
          return undefined;
      }
    });
  }
  if (target === STOCK_FACTORY.toLowerCase()) {
    return respond(FACTORY_ABI as Abi, data, (name, args) =>
      name === "tokenAddress" ? (chain.records.get(String(args[0]).toLowerCase()) ?? zeroAddress) : undefined,
    );
  }
  if (target === STOCK_REGISTRY.toLowerCase()) {
    return respond(REGISTRY_ABI as Abi, data, (name) => (name === "paused" ? chain.registryPaused : name === "implementation" ? STOCK_IMPLEMENTATION : undefined));
  }
  if (target === NVDA_FEED.toLowerCase()) {
    return respond(FEED_ABI as Abi, data, (name) => {
      if (name === "latestRoundData") return [18446744073709553223n, chain.feed.answer, BigInt(chain.feed.updatedAt), BigInt(chain.feed.updatedAt), 18446744073709553223n];
      if (name === "decimals") return 8;
      if (name === "description") return "RHNVDA / USD";
      return undefined;
    });
  }
  return { ok: false };
}

const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const hasCode = (chain: StockChain, address: string) =>
  chain.tokens.has(address.toLowerCase()) ||
  [STOCK_FACTORY, STOCK_REGISTRY, NVDA_FEED, MULTICALL3].some((known) => known.toLowerCase() === address.toLowerCase());

function call(chain: StockChain, method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x1237";
    case "eth_blockNumber":
      return hex(BLOCK);
    case "eth_getBlockByNumber":
      return {
        number: hex(BLOCK),
        hash: `0x${"bb".repeat(32)}`,
        parentHash: `0x${"00".repeat(32)}`,
        timestamp: hex(BLOCK_TIME),
        baseFeePerGas: "0x1",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        transactions: [],
        miner: zeroAddress,
        difficulty: "0x0",
        extraData: "0x",
        logsBloom: `0x${"0".repeat(512)}`,
        nonce: "0x0000000000000000",
        receiptsRoot: `0x${"00".repeat(32)}`,
        sha3Uncles: `0x${"00".repeat(32)}`,
        size: "0x1",
        stateRoot: `0x${"00".repeat(32)}`,
        totalDifficulty: "0x0",
        transactionsRoot: `0x${"00".repeat(32)}`,
        uncles: [],
      };
    case "eth_getCode":
      return hasCode(chain, String(params[0])) ? "0x6080604052" : "0x";
    case "eth_getStorageAt": {
      const [address, slot] = params as [string, string];
      const isToken = chain.tokens.has(address.toLowerCase());
      return isToken && slot.toLowerCase() === BEACON_SLOT ? pad(STOCK_REGISTRY.toLowerCase() as Hex) : `0x${"00".repeat(32)}`;
    }
    case "eth_getTransactionCount":
      return String(params[0]).toLowerCase() === STOCK_FACTORY.toLowerCase() ? hex(chain.factoryNonce) : "0x0";
    case "eth_call": {
      const { to, data } = params[0] as { to: string; data: Hex };
      if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName !== "aggregate3") throw new Error(`the stub does not answer Multicall3.${decoded.functionName}`);
        const results = decoded.args[0].map((inner) => {
          const result = answer(chain, inner.target, inner.callData);
          return result.ok ? { success: true, returnData: result.data } : { success: false, returnData: "0x" as Hex };
        });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
      }
      const result = answer(chain, to, data);
      if (!result.ok) throw Object.assign(new Error("execution reverted"), { code: 3 });
      return result.data;
    }
    default:
      throw new Error(`the stub chain does not answer ${method}`);
  }
}

/** Serve the chain at http://rpc.test and Chainlink's directory from the recorded entries. */
export async function stubStocks(page: Page, chain: StockChain): Promise<{ rpcCalls: string[] }> {
  const rpcCalls: string[] = [];
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST",
  };
  await page.route("http://rpc.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const payload = JSON.parse(route.request().postData() ?? "{}");
    const one = (request: { id: number; method: string; params?: unknown[] }) => {
      rpcCalls.push(request.method);
      try {
        return { jsonrpc: "2.0", id: request.id, result: call(chain, request.method, request.params ?? []) };
      } catch (error) {
        const code = (error as { code?: number }).code ?? -32601;
        return { jsonrpc: "2.0", id: request.id, error: { code, message: String((error as Error).message) } };
      }
    };
    const body = Array.isArray(payload) ? payload.map(one) : one(payload);
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
  });
  const directory = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../packages/stocks/test/fixtures/feed-directory.subset.json", import.meta.url)), "utf8"),
  ) as { entries: unknown[] };
  await page.route(FEED_DIRECTORY_URL, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(directory.entries) }),
  );
  return { rpcCalls };
}
