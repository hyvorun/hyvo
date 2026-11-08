/**
 * Wallet connection (wagmi + viem, SPEC 9.2) and Sign-In with Ethereum. Signing in is a message
 * signature: it costs nothing and moves no funds. The session token is kept in localStorage per
 * wallet address and sent as `Authorization: Bearer`.
 */
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { createSiweMessage } from "viem/siwe";
import type { Address, Hex } from "viem";
import { requestNonce, verifySignIn } from "./api";
import { CHAIN_ID, robinhoodChain, transports } from "./chain";

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: { [robinhoodChain.id]: transports() },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export interface Session {
  token: string;
  address: Address;
  expiresAt: string;
  admin: boolean;
}

const SESSION_KEY = "hyvo.session";
export const SIGN_IN_STATEMENT =
  "Sign in to Hyvo. This is a signature, not a transaction: it costs nothing and moves no funds.";

export function loadSession(address: string | undefined): Session | null {
  if (!address) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    if (!stored || stored.address.toLowerCase() !== address.toLowerCase()) return null;
    if (Date.parse(stored.expiresAt) <= Date.now() + 60_000) return null;
    return stored;
  } catch {
    return null;
  }
}

function saveSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage can be blocked; the session then lasts for this page view.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing stored
  }
}

/** Ask the API for a nonce, have the wallet sign an EIP-4361 message, and trade it for a session. */
export async function signIn(address: Address, sign: (message: string) => Promise<Hex>): Promise<Session> {
  const { nonce } = await requestNonce();
  const message = createSiweMessage({
    address,
    chainId: CHAIN_ID,
    domain: window.location.host,
    nonce,
    uri: window.location.origin,
    version: "1",
    statement: SIGN_IN_STATEMENT,
    issuedAt: new Date(),
  });
  const signature = await sign(message);
  const result = await verifySignIn(message, signature);
  const session: Session = { token: result.token, address: result.address as Address, expiresAt: result.expiresAt, admin: result.admin };
  saveSession(session);
  return session;
}

/** A wallet error as one plain sentence for the interface. */
export function walletMessage(error: unknown): string {
  const e = error as { name?: string; shortMessage?: string; message?: string } | null;
  const name = e?.name ?? "";
  if (name === "UserRejectedRequestError" || /rejected|denied/i.test(e?.shortMessage ?? e?.message ?? "")) {
    return "You declined in your wallet. Nothing was sent.";
  }
  if (name === "ProviderNotFoundError" || name === "ConnectorNotFoundError") {
    return "No browser wallet was found. Install one that can add Robinhood Chain (chain 4663), or open this page in a wallet's browser.";
  }
  if (name === "ChainNotConfiguredError" || name === "SwitchChainError") {
    return "Your wallet could not switch to Robinhood Chain (chain 4663). Add the network in the wallet and try again.";
  }
  return e?.shortMessage ?? e?.message ?? "Something went wrong in the wallet.";
}
