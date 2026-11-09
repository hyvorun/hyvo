/**
 * Whether the wallet signed in on this browser is a HYVO holder, for the holder utilities: the board's live refresh,
 * the watchlist kept with the account and more followed wallets on /track. A holder is decided by the API, the same
 * way as for free runs and the discount (HOLDER_RULE: at least 1,000,000 HYVO in one wallet, now and 24 hours
 * earlier), and read from GET /v1/me. Nothing here loads the wallet libraries: the session is read from storage.
 */
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { fetchMe } from "./api";
import { readStoredSession, SESSION_EVENT, SESSION_KEY, type StoredSession } from "./session";

export type HolderState = "unknown" | "signed-out" | "holder" | "not-holder";

export interface HolderStatusValue {
  /** "unknown" while the API is asked, or when it could not answer. */
  status: HolderState;
  /** The signed-in wallet, or null. */
  wallet: Address | null;
  /** The session token, for the account routes; null when signed out. */
  token: string | null;
  /** True while GET /v1/me is being asked for this session, so a page can wait for the answer before reading the chain. */
  checking: boolean;
  /** Read the session and ask the API again. */
  refresh: () => void;
}

/** How often the board refreshes: every 10 seconds for holders, every minute for everyone else. */
export const BOARD_REFRESH_MS = { holder: 10_000, everyone: 60_000 } as const;

export function boardRefreshMs(status: HolderState): number {
  return status === "holder" ? BOARD_REFRESH_MS.holder : BOARD_REFRESH_MS.everyone;
}

/** The status from a session and what GET /v1/me said about it: null for no answer (yet), "expired" for a 401. */
export function holderStateFrom(session: StoredSession | null, me: { eligible: boolean } | "expired" | null): HolderState {
  if (!session || me === "expired") return "signed-out";
  if (me === null) return "unknown";
  return me.eligible ? "holder" : "not-holder";
}

/** GET /v1/me answers per token, kept for a few minutes so the pieces of one page ask once. */
const ME_KEEP_MS = 5 * 60_000;
const answers = new Map<string, { at: number; answer: Promise<{ eligible: boolean } | "expired" | null> }>();

function askMe(token: string, fresh: boolean): Promise<{ eligible: boolean } | "expired" | null> {
  const kept = answers.get(token);
  if (kept && !fresh && Date.now() - kept.at < ME_KEEP_MS) return kept.answer;
  const answer = fetchMe(token).then(
    (me) => ({ eligible: me.holder.eligible }),
    (error: unknown) => ((error as { status?: number } | null)?.status === 401 ? ("expired" as const) : null),
  );
  answers.set(token, { at: Date.now(), answer });
  // An answer that could not be read is not kept: the next look asks again.
  void answer.then((value) => value === null && answers.delete(token));
  return answer;
}

/** The signed-in wallet's holder status, from the session in storage and GET /v1/me. */
export function useHolderStatus(): HolderStatusValue {
  const [session, setSession] = useState<StoredSession | null>(() => readStoredSession());
  const [me, setMe] = useState<{ eligible: boolean } | "expired" | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** Which ask (token and attempt) has answered, so "checking" holds from the render the ask starts in. */
  const [answered, setAnswered] = useState<string | null>(null);

  useEffect(() => {
    const look = () => setSession(readStoredSession());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === SESSION_KEY) look();
    };
    window.addEventListener(SESSION_EVENT, look);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SESSION_EVENT, look);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const token = session?.token ?? null;
  useEffect(() => {
    setMe(null);
    if (!token) return;
    let live = true;
    void askMe(token, attempt > 0).then((answer) => {
      if (!live) return;
      setMe(answer);
      setAnswered(`${token}:${attempt}`);
    });
    return () => {
      live = false;
    };
  }, [token, attempt]);

  const refresh = useCallback(() => {
    setSession(readStoredSession());
    setAttempt((n) => n + 1);
  }, []);

  const status = holderStateFrom(session, me);
  const checking = token !== null && answered !== `${token}:${attempt}`;
  return { status, wallet: status === "signed-out" ? null : (session?.address ?? null), token: status === "signed-out" ? null : token, checking, refresh };
}
