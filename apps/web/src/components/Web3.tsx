import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSignMessage, WagmiProvider } from "wagmi";
import { CHAIN_ID } from "../lib/chain";
import { clearSession, loadSession, signIn, wagmiConfig, walletMessage, type Session } from "../lib/wallet";

const queryClient = new QueryClient();

/** Wallet providers for the pages that need a wallet (loaded with those pages only). */
export function Web3({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

export interface WalletSession {
  address: `0x${string}` | undefined;
  chainId: number | undefined;
  connected: boolean;
  session: Session | null;
  busy: "connecting" | "signing" | null;
  error: string | null;
  /** Connect if needed, then sign in if needed; returns the session or null when it failed. */
  ensureSession: () => Promise<Session | null>;
  signOut: () => void;
}

export function useWalletSession(): WalletSession {
  const { address, chainId, status } = useConnection();
  const connectors = useConnectors();
  const { connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<Session | null>(() => loadSession(address));
  const [busy, setBusy] = useState<WalletSession["busy"]>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSession(loadSession(address)), [address]);

  const ensureSession = useCallback(async (): Promise<Session | null> => {
    setError(null);
    try {
      let account = address;
      if (status !== "connected" || !account) {
        // A wallet that announced itself (EIP-6963) over the generic window.ethereum connector.
        const connector = connectors.find((item) => item.id !== "injected") ?? connectors[0];
        if (!connector) throw Object.assign(new Error("no wallet"), { name: "ProviderNotFoundError" });
        setBusy("connecting");
        const result = await connectAsync({ connector, chainId: CHAIN_ID });
        account = result.accounts[0];
      }
      if (!account) throw new Error("The wallet did not share an address.");
      const existing = loadSession(account);
      if (existing) {
        setSession(existing);
        return existing;
      }
      setBusy("signing");
      const fresh = await signIn(account, (message) => signMessageAsync({ message, account }));
      setSession(fresh);
      return fresh;
    } catch (caught) {
      setError(walletMessage(caught));
      return null;
    } finally {
      setBusy(null);
    }
  }, [address, status, connectors, connectAsync, signMessageAsync]);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    disconnect();
  }, [disconnect]);

  return { address, chainId, connected: status === "connected", session, busy, error, ensureSession, signOut };
}
