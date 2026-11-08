/**
 * A stubbed Robinhood Chain for the browser tests: a JSON-RPC endpoint (http://rpc.test, the
 * app's VITE_RPC_URLS in playwright.config.ts) and an injected EIP-1193 wallet that signs with an
 * anvil test key in Node. Transactions are recorded, never sent anywhere.
 */
import type { Page } from "@playwright/test";
import { encodeAbiParameters, keccak256, toFunctionSelector, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// anvil's first default key: a public test key.
export const wallet = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

export interface ChainState {
  balance: bigint;
  allowance: bigint;
  commit: { reportHash: Hex; scenarioHash: Hex } | null;
  sent: { to: string; data: string }[];
}

export function chainState(overrides: Partial<ChainState> = {}): ChainState {
  return { balance: 0n, allowance: 0n, commit: null, sent: [], ...overrides };
}

const SELECTORS = {
  balanceOf: toFunctionSelector("balanceOf(address)"),
  allowance: toFunctionSelector("allowance(address,address)"),
  approve: toFunctionSelector("approve(address,uint256)"),
  getCommit: toFunctionSelector("getCommit(bytes32)"),
};

const COMMIT = [
  {
    type: "tuple",
    components: [
      { name: "reportHash", type: "bytes32" },
      { name: "scenarioHash", type: "bytes32" },
      { name: "resolvesAt", type: "uint64" },
      { name: "committedAt", type: "uint64" },
      { name: "resolvedAt", type: "uint64" },
      { name: "outcomeHash", type: "bytes32" },
    ],
  },
] as const;

const ZERO = `0x${"0".repeat(64)}` as Hex;

function call(state: ChainState, method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x1237";
    case "net_version":
      return "4663";
    case "eth_blockNumber":
      return "0x20";
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return "0x1";
    case "eth_estimateGas":
      return "0x5208";
    case "eth_getTransactionCount":
      return "0x0";
    case "eth_getBlockByNumber":
      return {
        number: "0x20",
        hash: `0x${"bb".repeat(32)}`,
        parentHash: ZERO,
        timestamp: "0x6a000000",
        baseFeePerGas: "0x1",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        transactions: [],
        miner: "0x0000000000000000000000000000000000000000",
        difficulty: "0x0",
        extraData: "0x",
        logsBloom: `0x${"0".repeat(512)}`,
        nonce: "0x0000000000000000",
        receiptsRoot: ZERO,
        sha3Uncles: ZERO,
        size: "0x1",
        stateRoot: ZERO,
        totalDifficulty: "0x0",
        transactionsRoot: ZERO,
        uncles: [],
      };
    case "eth_call": {
      const { data } = params[0] as { to: string; data: string };
      const selector = data.slice(0, 10);
      if (selector === SELECTORS.balanceOf) return encodeAbiParameters([{ type: "uint256" }], [state.balance]);
      if (selector === SELECTORS.allowance) return encodeAbiParameters([{ type: "uint256" }], [state.allowance]);
      if (selector === SELECTORS.getCommit) {
        const commit = state.commit;
        return encodeAbiParameters(COMMIT, [
          {
            reportHash: commit?.reportHash ?? ZERO,
            scenarioHash: commit?.scenarioHash ?? ZERO,
            resolvesAt: 0n,
            committedAt: commit ? 1_800_000_000n : 0n,
            resolvedAt: 0n,
            outcomeHash: ZERO,
          },
        ]);
      }
      return "0x";
    }
    case "eth_getTransactionReceipt": {
      const hash = params[0] as string;
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: `0x${"bb".repeat(32)}`,
        blockNumber: "0x1f",
        from: wallet.address,
        to: "0x00000000000000000000000000000000000dd002",
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x1",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        status: "0x1",
        type: "0x2",
      };
    }
    default:
      throw new Error(`the stub chain does not answer ${method}`);
  }
}

/** Serve JSON-RPC at http://rpc.test from `state`. */
export async function stubChain(page: Page, state: ChainState): Promise<void> {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST",
  };
  await page.route("http://rpc.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const payload = JSON.parse(route.request().postData() ?? "{}");
    const one = (request: { id: number; method: string; params?: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id: request.id, result: call(state, request.method, request.params ?? []) };
      } catch (error) {
        return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: String(error) } };
      }
    };
    const body = Array.isArray(payload) ? payload.map(one) : one(payload);
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
  });
}

/** Put an EIP-1193 wallet on `window.ethereum` that signs in Node and records transactions. */
export async function injectWallet(page: Page, state: ChainState): Promise<void> {
  let counter = 0;
  await page.exposeFunction("__hyvoWallet", async (method: string, params: unknown[]) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [wallet.address];
      case "personal_sign":
        return wallet.signMessage({ message: { raw: params[0] as Hex } });
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "eth_sendTransaction": {
        const tx = params[0] as { to: string; data: string };
        state.sent.push({ to: tx.to, data: tx.data });
        if (tx.data.startsWith(SELECTORS.approve)) state.allowance = BigInt(`0x${tx.data.slice(74)}`);
        return keccak256(toHex(`tx-${++counter}`));
      }
      default:
        return call(state, method, params);
    }
  });
  await page.addInitScript(() => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    // Looked up per call: the binding may be installed after this script runs.
    const bridge = (method: string, params: unknown[]) =>
      (window as unknown as { __hyvoWallet: (m: string, p: unknown[]) => Promise<unknown> }).__hyvoWallet(method, params);
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: ({ method, params }: { method: string; params?: unknown[] }) => bridge(method, params ?? []),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(listener);
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener);
      },
    };
  });
}
