/**
 * Runs Hyvo Check in the browser: @hyvo/check reads Robinhood Chain through the site's RPC endpoints
 * and Sourcify, straight from the visitor's browser, with no Hyvo server in between. Nothing is
 * signed or sent. A new address, or leaving the page, aborts the check that is running.
 */
import { checkToken, type CheckReport } from "@hyvo/check";
import { useCallback, useEffect, useState } from "react";
import { READ_RPC_URLS } from "./rpc-urls";

export type CheckState =
  | { status: "idle" }
  /** `previous` is the report on screen when the same token is read again. */
  | { status: "loading"; address: string; previous: CheckReport | null }
  | { status: "ready"; address: string; report: CheckReport }
  | { status: "error"; address: string; error: unknown };

/** Checks `address` (null: nothing to check) and returns the state, with a way to read it again. */
export function useCheck(address: string | null): [CheckState, () => void] {
  const [state, setState] = useState<CheckState>(() => (address ? { status: "loading", address, previous: null } : { status: "idle" }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!address) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({
      status: "loading",
      address,
      previous: current.status === "ready" && current.address === address ? current.report : null,
    }));
    checkToken(address, { rpcUrls: READ_RPC_URLS, signal: controller.signal }).then(
      (report) => {
        if (!controller.signal.aborted) setState({ status: "ready", address, report });
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
