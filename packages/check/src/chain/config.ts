// Network constants for Robinhood Chain mainnet, the only chain Hyvo Check reads. Sources for every value are
// listed in docs/OPEN_ITEMS.md ("Hyvo Check: addresses and limits").

export const ROBINHOOD_CHAIN = {
  /** eth_chainId answers 0x1237. */
  chainId: 4663,
  name: "Robinhood Chain",
  /** dRPC's keyless endpoint: the runner's RPC since 2026-11-02 (docs/OPEN_ITEMS.md item 3). */
  rpcUrls: ["https://robinhood.drpc.org"],
  explorerUrl: "https://robinhoodchain.blockscout.com",
  /** Sourcify's public server; it holds verified sources for chain 4663 and answers browsers (CORS). */
  sourcifyUrl: "https://sourcify.dev/server",
  /**
   * Blockscout's keyed API for chain 4663. The explorer's own host answers programs with a bot challenge, and
   * this API needs a key (docs/OPEN_ITEMS.md item 24): without one it answers 402.
   */
  blockscoutApiUrl: "https://api.blockscout.com/4663/api",
} as const;

/** The default amount the exit simulation buys with: 0.001 ETH. */
export const DEFAULT_ETH_IN = 10n ** 15n;

/** Reads happen this many blocks below the head, so a load-balanced RPC's slower nodes have the block too. */
export const HEAD_MARGIN = 2n;

export const DEFAULT_TIMEOUT_MS = 10_000;
