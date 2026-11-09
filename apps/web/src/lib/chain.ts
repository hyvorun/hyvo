/**
 * Robinhood Chain for the browser: the chain definition, RPC transports (tried in order) and the
 * few contract functions the app reads or calls. RPC URLs (lib/rpc-urls) and the explorer default
 * to the verified public endpoints (docs/OPEN_ITEMS.md item 3) and can be overridden at build time
 * with VITE_RPC_URLS (comma-separated) and VITE_EXPLORER_URL, as the local end-to-end test does.
 * VITE_ORACLE_ADDRESS pins the HyvoOracle address, so /oracle does not take it from the API.
 */
import { createPublicClient, defineChain, fallback, http, parseAbi, type Hex, type PublicClient } from "viem";
import { EXPLORER_URL } from "./explorer";
import { CONFIGURED_RPC_URLS, READ_RPC_URLS } from "./rpc-urls";

export const CHAIN_ID = 4663;

/** What VITE_RPC_URLS lists; empty when it is not set. */
export const RPC_URLS: string[] = CONFIGURED_RPC_URLS;

const rpcUrls = READ_RPC_URLS;

/** The HyvoOracle this build checks against; empty until the contract is deployed. */
export const PINNED_ORACLE = ((import.meta.env.VITE_ORACLE_ADDRESS as string | undefined) ?? "").trim();

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
});

export function transports() {
  return fallback(rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })));
}

let client: PublicClient | null = null;

/** A read-only client: the browser reads the chain itself, without the Hyvo API in between. */
export function publicClient(): PublicClient {
  client ??= createPublicClient({ chain: robinhoodChain, transport: transports() }) as PublicClient;
  return client;
}

export const ORACLE_ABI = parseAbi([
  "function getCommit(bytes32 runId) view returns ((bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint64 committedAt, uint64 resolvedAt, bytes32 outcomeHash))",
]);

export const ROUTER_ABI = parseAbi(["function pay(bytes32 orderId, address token, uint256 amount)"]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export type Bytes32 = Hex;
