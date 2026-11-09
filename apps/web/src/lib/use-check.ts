/**
 * Runs Hyvo Check in the browser: @hyvo/check reads Robinhood Chain through the site's RPC endpoints
 * and Sourcify, straight from the visitor's browser, with no Hyvo server in between. Nothing is
 * signed or sent. A new address, or leaving the page, aborts the check that is running.
 *
 * Top holders, and the deployer when no launch record or Sourcify names one, come from Blockscout's
 * index, which answers only with a key: Hyvo's API reads it with its own (`GET /v1/check/:token/holders`)
 * while the browser reads the chain, and the check leaves out burn addresses and pools as it always
 * does. When the API does not answer, those two findings stay skipped and say why.
 */
import { checkToken, type CheckReport, type HolderFacts } from "@hyvo/check";
import { useCallback, useEffect, useState } from "react";
import { API_URL } from "./api";
import { holdersFromApi } from "./check-view";
import { READ_RPC_URLS } from "./rpc-urls";

export type CheckState =
  | { status: "idle" }
  /** `previous` is the report on screen when the same token is read again, with its holder facts. */
  | { status: "loading"; address: string; previous: CheckReport | null; previousHolders: HolderFacts | null }
  /** `holders`: what Hyvo's API answered for the holders, or null when it was not asked. */
  | { status: "ready"; address: string; report: CheckReport; holders: HolderFacts | null }
  | { status: "error"; address: string; error: unknown };

/** How long the check waits for Hyvo's API before it leaves the holders skipped. */
const HOLDERS_TIMEOUT_MS = 8_000;

/** The token's holders and creator from Hyvo's API; never throws: no answer is facts that say why. */
export async function fetchHolderFacts(token: string, signal?: AbortSignal): Promise<HolderFacts> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOLDERS_TIMEOUT_MS);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop);
  try {
    const response = await fetch(`${API_URL}/v1/check/${token}/holders`, { headers: { Accept: "application/json" }, signal: controller.signal });
    const body: unknown = await response.json().catch(() => null);
    return holdersFromApi(response.status, body);
  } catch {
    return holdersFromApi(null, null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** Checks `address` (null: nothing to check) and returns the state, with a way to read it again. */
export function useCheck(address: string | null): [CheckState, () => void] {
  const [state, setState] = useState<CheckState>(() =>
    address ? { status: "loading", address, previous: null, previousHolders: null } : { status: "idle" },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!address) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((current) => {
      const same = current.status === "ready" && current.address === address;
      return { status: "loading", address, previous: same ? current.report : null, previousHolders: same ? current.holders : null };
    });
    let holders: HolderFacts | null = null;
    checkToken(address, {
      rpcUrls: READ_RPC_URLS,
      signal: controller.signal,
      holders: async (token, signal) => (holders = await fetchHolderFacts(token, signal)),
    }).then(
      (report) => {
        if (!controller.signal.aborted) setState({ status: "ready", address, report, holders });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", address, error });
      },
    );
    return () => controller.abort();
  }, [address, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, reload];
}
