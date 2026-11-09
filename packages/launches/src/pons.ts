/**
 * Pons on Robinhood Chain (chain ID 4663): the contracts Hyvo Launches reads and the parts of their
 * interfaces it uses. Every address, event and function here comes from a source that was read, not
 * from memory (docs/OPEN_ITEMS.md item 28):
 *
 * - The Pons V2 launch factory's verified source on Sourcify (exact match, verified 2026-08-04), which
 *   includes PonsV2BondingCurve.sol, PonsV2LauncherToken.sol and interfaces/ILaunchpadV2.sol. Every
 *   signature below is copied from those files.
 * - The Pons V1 factory's verified ABI on Sourcify (exact match).
 * - Calls to the chain on 2026-11-09: Multicall3 and the ArbSys precompile answer at the addresses below.
 */
import { parseAbi, toEventSelector, type Address, type Hex } from "viem";

export const CHAIN_ID = 4663;

/** PonsV2LaunchFactory, deployed in block 26,841,846 (Sourcify's deployment record). */
export const PONS_V2_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const PONS_V2_FACTORY_BLOCK = 26_841_846n;

/** The active Pons V1 factory (PonsLaunchFactory). V1 tokens pair with WETH in a Uniswap V3 pool at launch. */
export const PONS_V1_FACTORY: Address = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";

/** Multicall3, at its usual address; its code was read on chain 4663. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Arbitrum's ArbSys precompile. On an Arbitrum chain `block.number` inside a contract is the parent
 * chain's block, so the Robinhood Chain block a read happened at comes from `arbBlockNumber()`.
 */
export const ARBSYS: Address = "0x0000000000000000000000000000000000000064";

/** A launch paired with this address trades against native ETH (PonsV2BondingCurve.isNativeQuote). */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export const FACTORY_ABI = parseAbi([
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function maxCreatorTaxBps() view returns (uint256)",
]);

export const CURVE_ABI = parseAbi([
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "function token() view returns (address)",
  "function factory() view returns (address)",
  "function pairToken() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function launchedAt() view returns (uint256)",
  "function launchSupply() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function buybackEnabled() view returns (bool)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
]);

export const V1_FACTORY_ABI = parseAbi([
  "struct LaunchedTokenV1 { address token; address deployer; address pairedToken; address positionManager; uint256 positionId; uint256 dexId; uint256 launchConfigId; uint256 restrictionsEndBlock; uint256 supply; bool isToken0; uint24 poolFee; bool exists; uint256 initialBuyAmount; }",
  "function getLaunchedToken(address token) view returns (LaunchedTokenV1)",
]);

/**
 * PonsV2LauncherToken is OpenZeppelin's ERC20 with ERC20Burnable and mints its whole supply to its curve
 * (`_mint(curve_, supply_)`); `balanceOf` is copied from OpenZeppelin's ERC20.sol in the same verified sources.
 */
export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);

/** Some old tokens return bytes32 for name() and symbol(). */
export const ERC20_BYTES32_ABI = parseAbi(["function name() view returns (bytes32)", "function symbol() view returns (bytes32)"]);

export const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);

export const ARBSYS_ABI = parseAbi(["function arbBlockNumber() view returns (uint256)"]);

export const TOPICS = {
  tokenLaunched: toEventSelector("TokenLaunched(address,address,address,address,uint256,uint256)"),
  poolGraduated: toEventSelector("PoolGraduated(address,uint256,uint256,uint256)"),
  curveBuy: toEventSelector("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  curveSell: toEventSelector("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
} as const satisfies Record<string, Hex>;

/**
 * GraduationPhase in ILaunchpadV2.sol: still on the curve; the curve drained and waiting for its
 * Uniswap V4 pool; the pool created and its position locked; or the swept reserves released by hand
 * because the pair asset stopped transferring exactly.
 */
export type Phase = "curve" | "swept" | "graduated" | "rescued";

export const PHASES: readonly Phase[] = ["curve", "swept", "graduated", "rescued"];

export function phaseFromIndex(index: number): Phase | null {
  return PHASES[index] ?? null;
}
