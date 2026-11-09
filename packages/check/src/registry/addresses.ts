// DATA, not logic: the contracts on Robinhood Chain (4663) that Hyvo Check reads or trades through. Every
// address comes from a source that was read, listed next to it and in docs/OPEN_ITEMS.md ("Hyvo Check:
// addresses and limits"). Better missing than wrong.
//
// Factories are deliberately absent: each check reads them from the routers on-chain (Router02.factory(),
// SwapRouter02.factory()), and the Pons hook and PoolManager from the Pons v2 factory (memeHook(),
// poolManager()), so nothing here can drift from what the routers actually use.

import type { Address } from "../types.js";

export interface KnownContract {
  address: Address;
  /** Where the address comes from. */
  source: string;
}

const UNISWAP_DEPLOYMENTS =
  "Uniswap's deployments list, developers.uniswap.org/deployments.json (generated 2026-11-04 from github.com/Uniswap/contracts, status active)";

export const ADDRESSES = {
  weth: {
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    source:
      "Robinhood Chain docs, Token Contracts (docs.robinhood.com/chain/contracts); Router02.WETH() and SwapRouter02.WETH9() return it",
  },
  usdg: {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    source: "Robinhood Chain docs, Token Contracts; Paxos docs; docs/OPEN_ITEMS.md item 4",
  },
  uniswapV2Router02: {
    address: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
    source: `${UNISWAP_DEPLOYMENTS}; developers.uniswap.org/docs/protocols/v2/deployments; docs/OPEN_ITEMS.md item 5`,
  },
  uniswapV3SwapRouter02: {
    address: "0xCaf681a66D020601342297493863E78C959E5cb2",
    source: `${UNISWAP_DEPLOYMENTS}; the Pons v1 factory's getDexConfig(0) names it as its swap router`,
  },
  uniswapV3QuoterV2: {
    address: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
    source: `${UNISWAP_DEPLOYMENTS}; its factory() and WETH9() match SwapRouter02's`,
  },
  uniswapV4PoolManager: {
    address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    source: `${UNISWAP_DEPLOYMENTS}; developers.uniswap.org/docs/protocols/v4/deployments; the Pons v2 factory's and hook's poolManager() return it`,
  },
  uniswapInterfaceMulticall: {
    address: "0x282A3C4D320Cc7f0d5eaf56B8029e4B88338f0a3",
    source: `${UNISWAP_DEPLOYMENTS}; its bytecode dispatches multicall((address,uint256,bytes)[])`,
  },
  ponsV2Factory: {
    address: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    source: "docs/OPEN_ITEMS.md item 5 (docs.ponsfamily.com); exact match on Sourcify (PonsV2LaunchFactory)",
  },
  ponsV1Factory: {
    address: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB",
    source: "docs/OPEN_ITEMS.md item 5 (docs.ponsfamily.com); exact match on Sourcify (PonsLaunchFactory)",
  },
} as const satisfies Record<string, KnownContract>;

/** The Pons v2 hook as recorded in docs/OPEN_ITEMS.md item 5; checks use the factory's memeHook() instead. */
export const PONS_V2_HOOK_RECORDED: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

/** The address the probe's runtime code is placed at inside the simulation's eth_call. It holds nothing. */
export const PROBE_ADDRESS: Address = "0x00000000000000000000000000000000005E11C4";

/** The sender of the simulation's eth_call. Nothing is signed: an eth_call needs no key. */
export const PROBE_CALLER: Address = "0x00000000000000000000000000000000000F2011";

/** Burn addresses left out of holder concentration. */
export const BURN_ADDRESSES: Address[] = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
];
