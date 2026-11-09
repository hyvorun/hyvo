/** Links to the chain explorer. Apart from lib/chain, so that the home and run pages do not load viem. */
const DEFAULT_EXPLORER = "https://robinhoodchain.blockscout.com";

export const EXPLORER_URL = ((import.meta.env.VITE_EXPLORER_URL as string | undefined) || DEFAULT_EXPLORER).replace(/\/$/, "");

export function txUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function blockUrl(block: number): string {
  return `${EXPLORER_URL}/block/${block}`;
}

export function addressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function tokenUrl(address: string): string {
  return `${EXPLORER_URL}/token/${address}`;
}
