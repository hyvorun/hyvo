/**
 * The contracts behind Robinhood's stock tokens on Robinhood Chain (chain 4663), and the read-only
 * functions Hyvo calls on them. Every address here was found and checked on-chain on 2026-11-09;
 * docs/OPEN_ITEMS.md item 28 records how, with the sources.
 *
 * - Each stock token is a BeaconProxy whose beacon is the AccessControlsRegistry below. The
 *   registry hands out the Stock implementation and holds every role, the pause switch and the
 *   blocklist. Its source and the implementation's are verified on Sourcify (exact match).
 * - The StockFactory deploys the tokens and records each one by its uid: `tokenAddress(uid)`
 *   returns the token for a uid. Its source is not verified; its functions and its `Deployed`
 *   event were identified from its bytecode, and their behavior was checked against real tokens.
 *
 * Nothing here signs, sends or approves anything.
 */
import { parseAbi, type Address, type Hex } from "viem";

export const CHAIN_ID = 4663;

/** StockFactory (an ERC-1967 proxy). Deployed in block 7791 by DEPLOYER. */
export const STOCK_FACTORY: Address = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";
export const FACTORY_DEPLOY_BLOCK = 7791;

/** AccessControlsRegistry: every stock token's beacon, roles, pause switch and blocklist. Block 7662. */
export const STOCK_REGISTRY: Address = "0xe10b6f6B275de231345c20D14Ab812db62151b00";

/** The Stock implementation the registry handed out when Hyvo checked (src/Stock.sol). Block 7784. */
export const STOCK_IMPLEMENTATION: Address = "0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2";

/** The account that deployed the registry, the implementation and the factory. */
export const DEPLOYER: Address = "0x074377a78A9710A1D47244f89797718b4f491279";

/** Multicall3. Its code on Robinhood Chain is byte for byte the code on Ethereum mainnet. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** EIP-1967 storage slot holding a BeaconProxy's beacon. */
export const BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

/** ERC-8056 multipliers use 18 decimals: 1e18 is 1.0. */
export const MULTIPLIER_DECIMALS = 18;
export const ONE_MULTIPLIER = 10n ** 18n;

/** ERC-165 interface ids of ERC-8056, as the standard lists them. */
export const ERC8056_INTERFACES = {
  scaledUIAmount: "0xa60bf13d",
  newUIMultiplier: "0x4bd27648",
  balances: "0xd890fd71",
} as const satisfies Record<string, Hex>;

/** The read-only part of src/Stock.sol, plus the events the history scan reads. */
export const STOCK_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function totalSupplyUI() view returns (uint256)",
  "function uid() view returns (bytes32)",
  "function terms() pure returns (string)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function tokenPaused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  "event MetaDataUpdated(string name, string symbol)",
]);

/**
 * The StockFactory, as identified from its bytecode. `Deployed` matches
 * keccak256("Deployed(bytes32,address,string,string)"); the uid is its one indexed field.
 */
export const FACTORY_ABI = parseAbi([
  "function tokenAddress(bytes32 uid) view returns (address)",
  "function beacon() view returns (address)",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
  "event Deployed(bytes32 indexed uid, address token, string name, string symbol)",
]);

/** The read-only part of src/AccessControlsRegistry.sol. */
export const REGISTRY_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function implementation() view returns (address)",
  "function isBlocked(address account) view returns (bool)",
]);

/** Chainlink's AggregatorV3Interface, read through a feed's proxy. */
export const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

/** Where each fact comes from, for the pages and the CLI to link. */
export const SOURCES = {
  stockSource: `https://repo.sourcify.dev/${CHAIN_ID}/${STOCK_IMPLEMENTATION}`,
  registrySource: `https://repo.sourcify.dev/${CHAIN_ID}/${STOCK_REGISTRY}`,
  erc8056: "https://ercs.ethereum.org/ERCS/erc-8056",
  chainlinkRobinhood: "https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood",
  chainlinkTokenizedEquity: "https://docs.chain.link/data-feeds/tokenized-equity-feeds",
} as const;
