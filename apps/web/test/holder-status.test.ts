import { afterEach, describe, expect, it } from "vitest";
import { BOARD_REFRESH_MS, boardRefreshMs, holderStateFrom } from "../src/lib/holder-status";
import { readStoredSession, SESSION_KEY, type StoredSession } from "../src/lib/session";

const SESSION: StoredSession = { token: "t".repeat(40), address: `0x${"ab".repeat(20)}`, expiresAt: "2026-11-17T00:00:00Z", admin: false };
const NOW = Date.parse("2026-11-10T00:00:00Z");

function stubStorage(value: string | null | (() => never)) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (typeof value === "function" ? value() : key === SESSION_KEY ? value : null) },
  });
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("boardRefreshMs", () => {
  it("refreshes every 10 seconds for holders and every minute for everyone else", () => {
    expect(boardRefreshMs("holder")).toBe(10_000);
    expect(boardRefreshMs("not-holder")).toBe(60_000);
    expect(boardRefreshMs("signed-out")).toBe(60_000);
    // Until the API has answered, the board takes the slower pace.
    expect(boardRefreshMs("unknown")).toBe(60_000);
    expect(BOARD_REFRESH_MS).toEqual({ holder: 10_000, everyone: 60_000 });
  });
});

describe("holderStateFrom", () => {
  it("is signed out without a session, or when the API says the session has expired", () => {
    expect(holderStateFrom(null, null)).toBe("signed-out");
    expect(holderStateFrom(null, { eligible: true })).toBe("signed-out");
    expect(holderStateFrom(SESSION, "expired")).toBe("signed-out");
  });

  it("is unknown until GET /v1/me answers, then holder or not as the API decided", () => {
    expect(holderStateFrom(SESSION, null)).toBe("unknown");
    expect(holderStateFrom(SESSION, { eligible: true })).toBe("holder");
    expect(holderStateFrom(SESSION, { eligible: false })).toBe("not-holder");
  });
});

describe("readStoredSession", () => {
  it("reads the session the wallet sign-in stored", () => {
    stubStorage(JSON.stringify(SESSION));
    expect(readStoredSession(NOW)).toEqual(SESSION);
  });

  it("gives null for an expired, malformed or missing session, and when storage is blocked", () => {
    stubStorage(JSON.stringify({ ...SESSION, expiresAt: "2026-11-10T00:00:30Z" }));
    expect(readStoredSession(NOW)).toBeNull();
    stubStorage(JSON.stringify({ ...SESSION, address: "<b>me</b>" }));
    expect(readStoredSession(NOW)).toBeNull();
    stubStorage("{not json");
    expect(readStoredSession(NOW)).toBeNull();
    stubStorage(null);
    expect(readStoredSession(NOW)).toBeNull();
    stubStorage(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readStoredSession(NOW)).toBeNull();
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(readStoredSession(NOW)).toBeNull();
  });
});
