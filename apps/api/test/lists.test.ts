import { TRACKED_MAX_HOLDER, TrackedResponse, WATCHLIST_MAX, WatchlistResponse } from "@hyvo/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIST_REQUESTS_PER_MINUTE } from "../src/routes/lists";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { account, call, chainEnv, FakeChain, frozenClock, json, KEYS, resetDb, signIn } from "./helpers";

const NOW = 1_800_000_000;
const HOLDS = { now: 5_000n * 10n ** 18n, past: 5_000n * 10n ** 18n };
const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

let chain: FakeChain;

beforeEach(async () => {
  await resetDb();
  frozenClock(NOW);
  chain = new FakeChain(() => NOW).install();
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

async function holder(key: `0x${string}` = KEYS.user, balances = HOLDS) {
  const target = chainEnv();
  chain.balances.set(account(key).address.toLowerCase(), balances);
  return { target, headers: await signIn(target, key, NOW) };
}

describe("account lists for HYVO holders", () => {
  it("need a session", async () => {
    const target = chainEnv();
    expect((await call(target, "/v1/account/watchlist")).status).toBe(401);
    expect((await json(target, "/v1/account/tracked", { wallets: [] }, {}, "PUT")).status).toBe(401);
  });

  it("are refused to a wallet that does not hold the minimum now and 24 hours earlier", async () => {
    // Enough now, not enough a day ago: not a holder yet.
    const { target, headers } = await holder(KEYS.user, { now: 5_000n * 10n ** 18n, past: 999n * 10n ** 18n });
    const read = await call(target, "/v1/account/watchlist", { headers });
    expect(read.status).toBe(403);
    const body = (await read.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("holder_only");
    expect(body.error.message).toContain("at least 1000 HYVO in this wallet, now and 24 hours earlier");
    expect(body.error.message).toContain("stay saved in this browser");
    expect((await json(target, "/v1/account/watchlist", { tokens: [token(1)] }, headers, "PUT")).status).toBe(403);
    expect((await json(target, "/v1/account/tracked", { wallets: [token(1)] }, headers, "PUT")).status).toBe(403);
  });

  it("are refused while holder benefits are off", async () => {
    const target = chainEnv({ HYVO_TOKEN_ADDRESS: "" });
    const headers = await signIn(target, KEYS.user, NOW);
    const read = await call(target, "/v1/account/tracked", { headers });
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error: { code: string } }).error.code).toBe("holder_only");
  });

  it("are refused when the balance cannot be read, rather than guessed", async () => {
    const { target, headers } = await holder();
    chain.balanceOf = async () => {
      throw new Error("the RPC is down");
    };
    const read = await call(target, "/v1/account/watchlist", { headers });
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error: { message: string } }).error.message).toContain("could not be read just now");
  });

  it("keep a holder's watchlist, in order, each address once", async () => {
    const { target, headers } = await holder();
    const empty = WatchlistResponse.parse(await (await call(target, "/v1/account/watchlist", { headers })).json());
    expect(empty).toEqual({ tokens: [], updatedAt: null });

    const upper = `0x${"AB".repeat(20)}`;
    const saved = await json(target, "/v1/account/watchlist", { tokens: [token(2), upper, token(1), token(2), upper.toLowerCase()] }, headers, "PUT");
    expect(saved.status).toBe(200);
    expect(WatchlistResponse.parse(await saved.json()).tokens).toEqual([token(2), upper.toLowerCase(), token(1)]);

    const again = WatchlistResponse.parse(await (await call(target, "/v1/account/watchlist", { headers })).json());
    expect(again.tokens).toEqual([token(2), upper.toLowerCase(), token(1)]);
    expect(again.updatedAt).toBe(new Date(NOW * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));

    // A PUT replaces the whole list.
    await json(target, "/v1/account/watchlist", { tokens: [token(3)] }, headers, "PUT");
    expect(WatchlistResponse.parse(await (await call(target, "/v1/account/watchlist", { headers })).json()).tokens).toEqual([token(3)]);
  });

  it("keep each wallet's lists apart, and the watchlist apart from the followed wallets", async () => {
    const first = await holder(KEYS.user);
    const second = await holder(KEYS.other);
    await json(first.target, "/v1/account/watchlist", { tokens: [token(1)] }, first.headers, "PUT");
    await json(first.target, "/v1/account/tracked", { wallets: [token(9)] }, first.headers, "PUT");
    const other = WatchlistResponse.parse(await (await call(second.target, "/v1/account/watchlist", { headers: second.headers })).json());
    expect(other.tokens).toEqual([]);
    const tracked = TrackedResponse.parse(await (await call(first.target, "/v1/account/tracked", { headers: first.headers })).json());
    expect(tracked.wallets).toEqual([token(9)]);
  });

  it("hold at most 200 launches and 25 wallets", async () => {
    const { target, headers } = await holder();
    const tokens = Array.from({ length: WATCHLIST_MAX }, (_, i) => token(i + 1));
    expect((await json(target, "/v1/account/watchlist", { tokens }, headers, "PUT")).status).toBe(200);
    const tooMany = await json(target, "/v1/account/watchlist", { tokens: [...tokens, token(WATCHLIST_MAX + 1)] }, headers, "PUT");
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { error: { code: string } }).error.code).toBe("bad_request");

    const wallets = Array.from({ length: TRACKED_MAX_HOLDER }, (_, i) => token(i + 1));
    expect((await json(target, "/v1/account/tracked", { wallets }, headers, "PUT")).status).toBe(200);
    expect((await json(target, "/v1/account/tracked", { wallets: [...wallets, token(99)] }, headers, "PUT")).status).toBe(400);
  });

  it("refuse anything but a list of addresses", async () => {
    const { target, headers } = await holder();
    const bad = [{ tokens: ["0x123"] }, { tokens: "0x" }, { tokens: [token(1)], extra: true }, {}, { wallets: [token(1)] }];
    for (const body of bad) {
      const response = await json(target, "/v1/account/watchlist", body, headers, "PUT");
      expect(response.status).toBe(400);
    }
    const notJson = await call(target, "/v1/account/tracked", { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
    expect((await json(target, "/v1/account/tracked", { wallets: ["<script>"] }, headers, "PUT")).status).toBe(400);
  });

  it("are limited per wallet", async () => {
    const { target, headers } = await holder();
    for (let i = 0; i < LIST_REQUESTS_PER_MINUTE; i++) expect((await call(target, "/v1/account/tracked", { headers })).status).toBe(200);
    const limited = await call(target, "/v1/account/tracked", { headers });
    expect(limited.status).toBe(429);
  });

  it("answer the web app's preflight for PUT", async () => {
    const target = chainEnv({ WEB_ORIGIN: "http://localhost:5173" });
    const response = await call(target, "/v1/account/watchlist", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,authorization" },
    });
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("Access-Control-Allow-Methods") ?? "").toContain("PUT");
  });
});
