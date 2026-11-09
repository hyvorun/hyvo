/**
 * Live reads, each pinned to one block so the answers fit together. They take any viem
 * PublicClient, so the web app, a CLI or the Worker can bring their own transport. A reading holds
 * what the chain said and nothing more; facts.ts turns it into answers.
 */
import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  BEACON_SLOT,
  ERC8056_INTERFACES,
  FACTORY_ABI,
  FEED_ABI,
  MULTICALL3,
  REGISTRY_ABI,
  STOCK_ABI,
  STOCK_FACTORY,
  STOCK_REGISTRY,
} from "./contracts";

export interface TokenFacts {
  uid: Hex;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** totalSupply × uiMultiplier, from the token's ERC-8056 balances extension; null if it does not answer. */
  totalSupplyUI: bigint | null;
  uiMultiplier: bigint;
  newUIMultiplier: bigint;
  /** Unix seconds; 0 when the multiplier was never updated. */
  effectiveAt: bigint;
  /** The token's own pause or the registry's: transfers, approvals, mints and burns revert while true. */
  paused: boolean;
  tokenPaused: boolean | null;
  /** The flag Chainlink's Robinhood feeds honor: while true the feed holds its last value. */
  oraclePaused: boolean | null;
  registry: Address | null;
  terms: string | null;
  interfaces: { scaledUIAmount: boolean | null; newUIMultiplier: boolean | null; balances: boolean | null };
}

export interface StockReading {
  address: Address;
  blockNumber: bigint;
  /** The block's time, Unix seconds. */
  blockTime: number;
  hasCode: boolean;
  /** The EIP-1967 beacon slot: the registry, for a BeaconProxy of the stock system. */
  beacon: Address | null;
  /** Null when the contract does not answer the stock token functions. */
  token: TokenFacts | null;
  /** What the factory records for this contract's uid: `tokenAddress(uid)`. Null without a uid. */
  factoryRecord: Address | null;
  registryPaused: boolean | null;
  /** The implementation the registry hands out to every token. */
  implementation: Address | null;
}

const ok = <T>(result: { status: "success"; result: unknown } | { status: "failure" }): T | null =>
  result.status === "success" ? (result.result as T) : null;

/** Read a contract as a stock token at the latest block (or at `blockNumber`). */
export async function readStock(client: PublicClient, address: Address, options: { blockNumber?: bigint } = {}): Promise<StockReading> {
  const block =
    options.blockNumber === undefined ? await client.getBlock({ blockTag: "latest" }) : await client.getBlock({ blockNumber: options.blockNumber });
  const blockNumber = block.number;
  const token = (functionName: string, args: readonly unknown[] = []) => ({ address, abi: STOCK_ABI, functionName, args }) as const;
  const contracts = [
    token("uid"),
    token("name"),
    token("symbol"),
    token("decimals"),
    token("totalSupply"),
    token("totalSupplyUI"),
    token("uiMultiplier"),
    token("newUIMultiplier"),
    token("effectiveAt"),
    token("paused"),
    token("tokenPaused"),
    token("oraclePaused"),
    token("ACCESS_CONTROLLED_REGISTRY"),
    token("terms"),
    token("supportsInterface", [ERC8056_INTERFACES.scaledUIAmount]),
    token("supportsInterface", [ERC8056_INTERFACES.newUIMultiplier]),
    token("supportsInterface", [ERC8056_INTERFACES.balances]),
    { address: STOCK_REGISTRY, abi: REGISTRY_ABI, functionName: "paused", args: [] },
    { address: STOCK_REGISTRY, abi: REGISTRY_ABI, functionName: "implementation", args: [] },
  ];

  const [code, beaconWord, results] = await Promise.all([
    client.getCode({ address, blockNumber }),
    client.getStorageAt({ address, slot: BEACON_SLOT, blockNumber }),
    client.multicall({
      contracts: contracts as Parameters<PublicClient["multicall"]>[0]["contracts"],
      allowFailure: true,
      blockNumber,
      multicallAddress: MULTICALL3,
    }) as Promise<({ status: "success"; result: unknown } | { status: "failure"; error: Error })[]>,
  ]);

  const value = <T>(index: number) => ok<T>(results[index]!);
  const hasCode = code !== undefined && code !== "0x";
  const beaconHex = beaconWord && beaconWord !== "0x" ? (`0x${beaconWord.slice(-40)}` as Address) : null;
  const beacon = beaconHex && beaconHex.toLowerCase() !== zeroAddress ? getAddress(beaconHex) : null;

  const uid = value<Hex>(0);
  const uiMultiplier = value<bigint>(6);
  const newUIMultiplier = value<bigint>(7);
  const effectiveAt = value<bigint>(8);
  const paused = value<boolean>(9);
  const name = value<string>(1);
  const symbol = value<string>(2);
  const decimals = value<number>(3);
  const totalSupply = value<bigint>(4);
  // The functions without which nothing below means anything.
  const answers = hasCode && uid !== null && name !== null && symbol !== null && decimals !== null && totalSupply !== null;
  const facts: TokenFacts | null =
    answers && uiMultiplier !== null && newUIMultiplier !== null && effectiveAt !== null && paused !== null
      ? {
          uid: uid!,
          name: name!,
          symbol: symbol!,
          decimals: Number(decimals),
          totalSupply: totalSupply!,
          totalSupplyUI: value<bigint>(5),
          uiMultiplier,
          newUIMultiplier,
          effectiveAt,
          paused,
          tokenPaused: value<boolean>(10),
          oraclePaused: value<boolean>(11),
          registry: value<Address>(12),
          terms: value<string>(13),
          interfaces: { scaledUIAmount: value<boolean>(14), newUIMultiplier: value<boolean>(15), balances: value<boolean>(16) },
        }
      : null;

  let factoryRecord: Address | null = null;
  if (facts) {
    factoryRecord = await client.readContract({ address: STOCK_FACTORY, abi: FACTORY_ABI, functionName: "tokenAddress", args: [facts.uid], blockNumber });
  }

  return {
    address,
    blockNumber,
    blockTime: Number(block.timestamp),
    hasCode,
    beacon,
    token: facts,
    factoryRecord,
    registryPaused: value<boolean>(17),
    implementation: value<Address>(18),
  };
}

export interface FeedReading {
  proxy: Address;
  description: string | null;
  decimals: number;
  roundId: bigint;
  answer: bigint;
  /** Unix seconds. */
  updatedAt: number;
  blockNumber: bigint;
}

/** A Chainlink feed's latest round, read at `blockNumber`. */
export async function readFeed(client: PublicClient, proxy: Address, blockNumber: bigint): Promise<FeedReading> {
  const [round, decimals, description] = await client.multicall({
    contracts: [
      { address: proxy, abi: FEED_ABI, functionName: "latestRoundData" },
      { address: proxy, abi: FEED_ABI, functionName: "decimals" },
      { address: proxy, abi: FEED_ABI, functionName: "description" },
    ],
    allowFailure: true,
    blockNumber,
    multicallAddress: MULTICALL3,
  });
  if (round.status !== "success" || decimals.status !== "success") throw new Error(`The Chainlink feed at ${proxy} did not answer latestRoundData().`);
  const [roundId, answer, , updatedAt] = round.result;
  return {
    proxy,
    description: description.status === "success" ? description.result : null,
    decimals: Number(decimals.result),
    roundId,
    answer,
    updatedAt: Number(updatedAt),
    blockNumber,
  };
}

/** The factory's nonce now: one for its creation plus one per token it deployed. */
export async function readFactoryNonce(client: PublicClient): Promise<number> {
  return client.getTransactionCount({ address: STOCK_FACTORY });
}
