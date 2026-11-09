/**
 * A saved list (the watchlist or the followed wallets) for a page: kept in this browser for everyone, and for a HYVO
 * holder also with their account (GET and PUT /v1/account/...), so it reaches their other browsers. When a holder's
 * page opens, the account's list and this browser's are merged against the list the two last agreed on: what another
 * browser took off stays off, and what this browser added or took off since then is kept.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTracked, fetchWatchlist, saveTracked, saveWatchlist } from "./api";
import type { HolderStatusValue } from "./holder-status";
import { browserStorage, LIST_KEYS, LIST_MAX, loadBase, loadList, mergeWithBase, saveBase, saveList, sameList, type ListKind } from "./saved-lists";

export type SyncState = "browser" | "syncing" | "synced" | "failed";

export interface SavedList {
  list: `0x${string}`[];
  /** Replace the list: kept in this browser at once, and with a holder's account shortly after. */
  set: (next: `0x${string}`[]) => void;
  sync: SyncState;
  syncError: string | null;
  /** False while a holder's list is still being merged with the account's: the list may change once more. */
  ready: boolean;
}

const SAVE_AFTER_MS = 500;

async function accountList(kind: ListKind, token: string): Promise<string[]> {
  return kind === "watchlist" ? (await fetchWatchlist(token)).tokens : (await fetchTracked(token)).wallets;
}

async function saveAccountList(kind: ListKind, token: string, list: readonly string[]): Promise<void> {
  if (kind === "watchlist") await saveWatchlist(token, list);
  else await saveTracked(token, list);
}

export function useSavedList(kind: ListKind, holder: Pick<HolderStatusValue, "status" | "token" | "wallet">): SavedList {
  const [list, setList] = useState<`0x${string}`[]>(() => loadList(browserStorage(), kind));
  const [sync, setSync] = useState<SyncState>("browser");
  const [syncError, setSyncError] = useState<string | null>(null);
  /** The token whose account list has been merged, and whether the account's list was read. */
  const [merge, setMerge] = useState<{ token: string; read: boolean } | null>(null);
  const timer = useRef(0);
  const token = holder.status === "holder" ? holder.token : null;
  const wallet = token ? holder.wallet : null;

  // Another tab changed the list.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === LIST_KEYS[kind]) setList(loadList(browserStorage(), kind));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [kind]);

  // A holder's page merges the account's list and this browser's.
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
        const storage = browserStorage();
        const joined = mergeWithBase(account, loadList(storage, kind), wallet ? loadBase(storage, kind, wallet) : null, LIST_MAX[kind]);
        saveList(storage, kind, joined);
        setList(joined);
        setMerge({ token, read: true });
        try {
          if (!sameList(joined, account)) await saveAccountList(kind, token, joined);
          if (wallet) saveBase(browserStorage(), kind, wallet, joined);
          if (live) setSync("synced");
        } catch (error) {
          if (!live) return;
          setSync("failed");
          setSyncError(error instanceof Error ? error.message : "The list could not be saved with your account.");
        }
      },
      (error: unknown) => {
        if (!live) return;
        setMerge({ token, read: false });
        setSync("failed");
        setSyncError(error instanceof Error ? error.message : "The list kept with your account could not be read.");
      },
    );
    return () => {
      live = false;
    };
  }, [kind, token, wallet]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Only a list merged with the account's is sent to it: before that (or when the account's list could not be read) a
  // PUT would replace launches saved from another browser. The merge sends this browser's changes itself.
  const canSave = token !== null && merge?.token === token && merge.read;

  const set = useCallback(
    (next: `0x${string}`[]) => {
      setList(next);
      saveList(browserStorage(), kind, next);
      if (!token || !canSave) return;
      window.clearTimeout(timer.current);
      setSync("syncing");
      timer.current = window.setTimeout(() => {
        saveAccountList(kind, token, next).then(
          () => {
            if (wallet) saveBase(browserStorage(), kind, wallet, next);
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
    [kind, token, wallet, canSave],
  );

  return { list, set, sync, syncError, ready: token === null || merge?.token === token };
}
