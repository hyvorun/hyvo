import { MeResponse, NonceResponse, SessionResponse } from "@hyvo/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { account, call, chainEnv, FakeChain, frozenClock, json, KEYS, resetDb, siweMessage, signIn } from "./helpers";

const NOW = 1_800_000_000;

beforeEach(async () => {
  await resetDb();
  frozenClock(NOW);
  new FakeChain(() => NOW).install(); // no test reaches a real RPC
});

afterEach(() => {
  setClock(null);
  setChainFactory(null);
});

async function nonce(target = chainEnv()): Promise<string> {
  const response = await json(target, "/v1/auth/siwe/nonce", {});
  expect(response.status).toBe(201);
  return NonceResponse.parse(await response.json()).nonce;
}

async function verify(message: string, key: `0x${string}` = KEYS.user, target = chainEnv()) {
  const signature = await account(key).signMessage({ message });
  return json(target, "/v1/auth/siwe/verify", { message, signature });
}

describe("Sign-In with Ethereum", () => {
  it("gives a session for a valid signed message, used once", async () => {
    const target = chainEnv();
    const user = account(KEYS.user);
    const message = siweMessage(user.address, await nonce(target), NOW);
    const first = await verify(message, KEYS.user, target);
    expect(first.status).toBe(201);
    const session = SessionResponse.parse(await first.json());
    expect(session.address).toBe(user.address);
    expect(session.admin).toBe(false);

    const me = await call(target, "/v1/me", { headers: { Authorization: `Bearer ${session.token}` } });
    expect(me.status).toBe(200);
    expect(MeResponse.parse(await me.json()).address).toBe(user.address);

    // The nonce is spent.
    const again = await verify(message, KEYS.user, target);
    expect(again.status).toBe(401);
  });

  it.each([
    ["another domain", { domain: "evil.example" }],
    ["another chain", { chainId: 1 }],
    ["another URI", { uri: "https://evil.example" }],
    ["an expired message", { expirationTime: new Date((NOW - 60) * 1000) }],
    ["a message from the future", { issuedAt: new Date((NOW + 3600) * 1000) }],
  ])("refuses %s", async (_name, overrides) => {
    const message = siweMessage(account(KEYS.user).address, await nonce(), NOW, overrides);
    const response = await verify(message);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_signature");
  });

  it("accepts each of the site's domains while it moves, on its own origin only", async () => {
    // Moving from *.pages.dev to its own domain: both serve the site for a while.
    const target = chainEnv({ WEB_ORIGIN: "https://hyvo.run,https://hyvo.pages.dev", SIWE_DOMAIN: "hyvo.run,hyvo.pages.dev" });
    const user = account(KEYS.user).address;
    for (const host of ["hyvo.run", "hyvo.pages.dev"]) {
      const message = siweMessage(user, await nonce(target), NOW, { domain: host, uri: `https://${host}` });
      expect((await verify(message, KEYS.user, target)).status).toBe(201);
    }
    // A domain paired with the other site's origin, or a domain not on the list, is refused.
    const crossed = siweMessage(user, await nonce(target), NOW, { domain: "hyvo.run", uri: "https://hyvo.pages.dev" });
    expect((await verify(crossed, KEYS.user, target)).status).toBe(401);
    const stranger = siweMessage(user, await nonce(target), NOW, { domain: "evil.example", uri: "https://evil.example" });
    expect((await verify(stranger, KEYS.user, target)).status).toBe(401);
  });

  it("refuses a signature by another key and an unknown nonce", async () => {
    const message = siweMessage(account(KEYS.user).address, await nonce(), NOW);
    expect((await verify(message, KEYS.other)).status).toBe(401);
    const made_up = siweMessage(account(KEYS.user).address, "abcdefghijklmnopqrstuvwx", NOW);
    expect((await verify(made_up)).status).toBe(401);
  });

  it("refuses an expired nonce", async () => {
    const clock = frozenClock(NOW);
    const value = await nonce();
    clock.advance(601);
    const message = siweMessage(account(KEYS.user).address, value, clock.now());
    expect((await verify(message)).status).toBe(401);
  });

  it("marks admin wallets", async () => {
    const target = chainEnv();
    const message = siweMessage(account(KEYS.admin).address, await nonce(target), NOW);
    const session = SessionResponse.parse(await (await verify(message, KEYS.admin, target)).json());
    expect(session.admin).toBe(true);
  });

  it("ends a session on logout", async () => {
    const target = chainEnv();
    const headers = await signIn(target, KEYS.user, NOW);
    expect((await json(target, "/v1/auth/logout", {}, headers)).status).toBe(200);
    expect((await call(target, "/v1/me", { headers })).status).toBe(401);
  });

  it("needs a session for /v1/me", async () => {
    expect((await call(chainEnv(), "/v1/me")).status).toBe(401);
    expect((await call(chainEnv(), "/v1/me", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("rate-limits nonces per IP", async () => {
    const target = chainEnv();
    for (let i = 0; i < 30; i++) expect((await json(target, "/v1/auth/siwe/nonce", {})).status).toBe(201);
    const limited = await json(target, "/v1/auth/siwe/nonce", {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();
  });
});

describe("holder status", () => {
  it("is off without a token address", async () => {
    const target = chainEnv({ HYVO_TOKEN_ADDRESS: "" });
    const headers = await signIn(target, KEYS.user, NOW);
    const me = MeResponse.parse(await (await call(target, "/v1/me", { headers })).json());
    expect(me.holder).toMatchObject({ enabled: false, eligible: false, freeRunsLeft: 0, discountBps: 0 });
  });

  it("needs the minimum now and 24 h ago", async () => {
    const target = chainEnv();
    const chain = new FakeChain(() => NOW).install();
    const user = account(KEYS.user).address.toLowerCase();
    const headers = await signIn(target, KEYS.user, NOW);
    const me = async () => MeResponse.parse(await (await call(target, "/v1/me", { headers })).json()).holder;

    chain.balances.set(user, { now: 5_000n * 10n ** 18n, past: 999n * 10n ** 18n });
    expect(await me()).toMatchObject({ enabled: true, eligible: false, balance: "5000", balance24hAgo: "999" });

    chain.balances.set(user, { now: 1_000n * 10n ** 18n, past: 1_000n * 10n ** 18n });
    expect(await me()).toMatchObject({ eligible: true, freeRunsLeft: 2, discountBps: 2000 });
  });
});
