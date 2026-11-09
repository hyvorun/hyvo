/**
 * The contracts the launch scripts read, and the parts of their interfaces they use.
 *
 * - The Pons V2 launch factory and its `getLaunchedToken` record are copied from packages/launches/src/pons.ts,
 *   which copied them from the factory's verified source on Sourcify (docs/OPEN_ITEMS.md item 29).
 * - PaymentRouter and HyvoOracle are Hyvo's own (chain/src, ABIs in chain/artifacts); both are Ownable2Step.
 */
import { getAddress, isAddress, parseAbi, zeroAddress, type Address } from "viem";

export const CHAIN_ID = 4663;

/** PonsV2LaunchFactory (docs/OPEN_ITEMS.md item 29). */
export const PONS_V2_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const SITE = "https://hyvo.run";

export const FACTORY_ABI = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);

export interface LaunchedToken {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: bigint;
  exists: boolean;
}

/** GraduationPhase in the factory's ILaunchpadV2.sol, as packages/launches/src/pons.ts names it. */
export const PHASES = ["on its Pons curve", "curve swept, pool not created yet", "in its Uniswap V4 pool", "swept reserves released by hand"] as const;

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

export const ROUTER_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function treasury() view returns (address)",
  "function allowedToken(address token) view returns (bool)",
  "function setTreasury(address newTreasury)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
]);

export const ORACLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
]);

/** chain/deployments/4663.json, as chain/script/DeployHyvo.s.sol writes it. */
export interface Deployment {
  attester?: string;
  block?: number;
  chainId: number;
  deployer: string;
  hyvoToken?: string;
  oracle: string;
  owner?: string;
  paymentRouter: string;
  treasury?: string;
  usdg?: string;
}

export function parseDeployment(text: string): Deployment {
  const value = JSON.parse(text) as Partial<Deployment>;
  for (const key of ["deployer", "oracle", "paymentRouter"] as const) {
    if (!isAddress(String(value[key] ?? ""), { strict: false })) throw new Error(`the deployment file has no valid "${key}"`);
  }
  if (typeof value.chainId !== "number") throw new Error('the deployment file has no "chainId"');
  return value as Deployment;
}

/** A checksummed address, or null for anything else (the zero address included). */
export function addressOrNull(value: string | undefined | null): Address | null {
  const text = (value ?? "").trim();
  if (!isAddress(text, { strict: false }) || text.toLowerCase() === zeroAddress) return null;
  return getAddress(text);
}

export function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase();
}

export function addressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}
