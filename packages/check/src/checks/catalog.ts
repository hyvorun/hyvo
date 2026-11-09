import type { CheckId } from "../types.js";

/** Every check, in report order: its title and what `found` means for it. For pages, CLIs and docs. */
export const CHECKS: Record<CheckId, { title: string; looksFor: string }> = {
  source: {
    title: "Verified source",
    looksFor: "Verified source code for the token's contract on Sourcify (and on Blockscout, given a key).",
  },
  owner: {
    title: "Owner address",
    looksFor: "An address other than zero returned by owner() or getOwner().",
  },
  proxy: {
    title: "Proxy",
    looksFor: "Code that runs another contract's logic: an EIP-1967 implementation or beacon slot, or an EIP-1167 clone.",
  },
  mint: {
    title: "Mint function",
    looksFor: "A state-changing function that creates new tokens, such as mint or mintTo.",
  },
  "fee-setter": {
    title: "Fee or tax setter",
    looksFor: "A function that sets a fee or tax rate, such as setFee, setTaxes or setSellTax.",
  },
  blocklist: {
    title: "Address blocklist",
    looksFor: "A function that blocks or freezes a given address, such as blacklist, setBlocked or freeze.",
  },
  pause: {
    title: "Pause or trading switch",
    looksFor: "A function that pauses the token or turns trading on or off.",
  },
  venue: {
    title: "Trading venue",
    looksFor: "Where the token trades against ETH: a Pons launch, a Uniswap V2 pair or V3 pool with WETH, or a V4 pool.",
  },
  "sell-simulation": {
    title: "Sell or transfer shortfall",
    looksFor:
      "After a simulated buy at one block: a transfer or sell that reverts, or any step that arrives short of what the venue's own math promised.",
  },
  holders: {
    title: "Top holders",
    looksFor:
      "How much of the supply the ten largest holders hold, leaving out burn addresses, the Uniswap V4 PoolManager, the token's Pons curve and its Uniswap V2 pair and V3 pools with WETH.",
  },
  deployer: {
    title: "Deployer",
    looksFor: "Who created or launched the token, and through which launchpad.",
  },
};

export const CHECK_ORDER: readonly CheckId[] = [
  "source",
  "owner",
  "proxy",
  "mint",
  "fee-setter",
  "blocklist",
  "pause",
  "venue",
  "sell-simulation",
  "holders",
  "deployer",
];
