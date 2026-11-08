/**
 * The contract addresses this build was made with. The deploy script passes them from
 * chain/deployments/4663.json; a local build has none. An empty string means "not set", and the
 * zero address (the Hyvo token before its launch) counts as not set. No viem here, so a page that
 * only shows an address does not load the chain code.
 */
function address(value: string | undefined): string {
  const text = (value ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) && !/^0x0{40}$/.test(text) ? text : "";
}

export const ADDRESSES = {
  oracle: address(import.meta.env.VITE_ORACLE_ADDRESS as string | undefined),
  paymentRouter: address(import.meta.env.VITE_PAYMENT_ROUTER_ADDRESS as string | undefined),
  usdg: address(import.meta.env.VITE_USDG_ADDRESS as string | undefined),
  hyvoToken: address(import.meta.env.VITE_HYVO_TOKEN_ADDRESS as string | undefined),
};
