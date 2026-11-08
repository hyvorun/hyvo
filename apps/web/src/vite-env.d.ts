/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Comma-separated Robinhood Chain RPC URLs, tried in order (default: the public endpoints). */
  readonly VITE_RPC_URLS?: string;
  readonly VITE_EXPLORER_URL?: string;
  /** The HyvoOracle address from chain/deployments/4663.json. Without it /oracle trusts the API's. */
  readonly VITE_ORACLE_ADDRESS?: string;
  /** The PaymentRouter, USDG and Hyvo token addresses from the same file, for /trust and /token. */
  readonly VITE_PAYMENT_ROUTER_ADDRESS?: string;
  readonly VITE_USDG_ADDRESS?: string;
  /** Empty (or the zero address) until the token launches. */
  readonly VITE_HYVO_TOKEN_ADDRESS?: string;
}
