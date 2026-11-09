/**
 * The JSON-RPC endpoints the browser reads Robinhood Chain through, tried in order. Apart from
 * lib/chain, so that a page can read the chain without loading viem (Hyvo Check reads it through
 * @hyvo/check). Defaults to the verified public endpoints (docs/OPEN_ITEMS.md item 3); VITE_RPC_URLS
 * (comma-separated) overrides them at build time, as the end-to-end tests do.
 */

// dRPC first: some ISPs block *.robinhood.com, and the official RPC is rate-limited.
export const DEFAULT_RPC_URLS = ["https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com"];

/** What VITE_RPC_URLS lists; empty when it is not set. */
export const CONFIGURED_RPC_URLS: string[] = ((import.meta.env.VITE_RPC_URLS as string | undefined) ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

/** The endpoints in use: VITE_RPC_URLS when set, the defaults otherwise. */
export const READ_RPC_URLS: string[] = CONFIGURED_RPC_URLS.length > 0 ? CONFIGURED_RPC_URLS : DEFAULT_RPC_URLS;
