/**
 * A saved list (the watchlist or the followed wallets) for a page: kept in this browser for everyone, and for a HYVO
 * holder also with their account (GET and PUT /v1/account/...), so it reaches their other browsers. When a holder's
 * page opens, the account's list and this browser's are joined, the account's first.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTracked, fetchWatchlist, saveTracked, saveWatchlist } from "./api";
import type { HolderStatusValue } from "./holder-status";
import { browserStorage, LIST_KEYS, LIST_MAX, loadList, mergeLists, saveList, sameList, type ListKind } from "./saved-lists";

export type SyncState = "browser" | "syncing" | "synced" | "failed";

export interface SavedList {
  list: `0x${string}`[];
  /** Replace the list: kept in this browser at once, and with a holder's account shortly after. */
  set: (next: `0x${string}`[]) => void;
  sync: SyncState;
  syncError: string | null;
}

const SAVE_AFTER_MS = 500;

async function accountList(kind: ListKind, token: string): Promise<string[]> {
  return kind === "watchlist" ? (await fetchWatchlist(token)).tokens : (await fetchTracked(token)).wallets;
}

async function saveAccountList(kind: ListKind, token: string, list: readonly string[]): Promise<void> {
  if (kind === "watchlist") await saveWatchlist(token, list);
  else await saveTracked(token, list);
}

export function useSavedList(kind: ListKind, holder: Pick<HolderStatusValue, "status" | "token">): SavedList {
  const [list, setList] = useState<`0x${string}`[]>(() => loadList(browserStorage(), kind));
  const [sync, setSync] = useState<SyncState>("browser");
  const [syncError, setSyncError] = useState<string | null>(null);
  const timer = useRef(0);
  const token = holder.status === "holder" ? holder.token : null;

  // Another tab changed the list.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === LIST_KEYS[kind]) setList(loadList(browserStorage(), kind));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [kind]);

  // A holder's page joins the account's list and this browser's.
  useEffect(() => {
    if (!token) {
      setSync("browser");
      return;
    }
    let live = true;
    setSync("syncing");
    setSyncError(null);
    accountList(kind, token).then(
      async (account) => {
        if (!live) return;
        const local = loadList(browserStorage(), kind);
        const joined = mergeLists(account, local, LIST_MAX[kind]);
        saveList(browserStorage(), kind, joined);
        setList(joined);
        try {
          if (!sameList(joined, account)) await saveAccountList(kind, token, joined);
          if (live) setSync("synced");
        } catch (error) {
          if (!live) return;
          setSync("failed");
          setSyncError(error instanceof Error ? error.message : "The list could not be saved with your account.");
        }
      },
      (error: unknown) => {
        if (!live) return;
        setSync("failed");
        setSyncError(error instanceof Error ? error.message : "The list kept with your account could not be read.");
      },
    );
    return () => {
      live = false;
    };
  }, [kind, token]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const set = useCallback(
    (next: `0x${string}`[]) => {
      setList(next);
      saveList(browserStorage(), kind, next);
      if (!token) return;
      window.clearTimeout(timer.current);
      setSync("syncing");
      timer.current = window.setTimeout(() => {
        saveAccountList(kind, token, next).then(
          () => {
            setSync("synced");
            setSyncError(null);
          },
          (error: unknown) => {
            setSync("failed");
            setSyncError(error instanceof Error ? error.message : "The list could not be saved with your account.");
          },
        );
      }, SAVE_AFTER_MS);
    },
    [kind, token],
  );

  return { list, set, sync, syncError };
}
