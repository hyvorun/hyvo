/**
 * Hyvo Check from the Worker: `GET /v1/check/:token` and MCP's check_token, run inside workerd against the fake
 * Robinhood Chain of @hyvo/check's own tests (JSON-RPC, the multicall, the probe and Sourcify; no network).
 */
import { CHECK_NOTICE, CHECK_ORDER, checkToken, serializeReport, type FetchLike } from "@hyvo/check";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAIR, PLAIN_RESULT, TOKEN, fakeChain, type Scenario } from "../../../packages/check/test/fake-chain";
import type { Env } from "../src/env";
import { CHECKS_PER_MINUTE, RPC_ATTEMPTS, SKIPPED_BY_API, setCheckRuntime } from "../src/lib/check";
import { iso, setClock } from "../src/lib/clock";
import { TOOLS } from "../src/routes/mcp";
import { call, chainEnv, frozenClock, resetDb } from "./helpers";

const NOW = 1_800_000_000; // a whole minute
const RPC = "http://chain.test"; // chainEnv's RPC_URLS
const DISCLAIMER = "Measured on-chain at block 254. Not a trading signal."; // the fake chain's head is 256
// The words Hyvo never uses about a token (packages/check/src/output/copy.ts).
const BANNED = /\b(safe|safely|safety|scams?|scammy|rugs?|rugged|rug ?pulls?|honey ?pots?|legit(imate)?|guarantee[ds]?|will pump|good token|bad token)\b/i;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967
const IMPLEMENTATION = getAddress("0x1234567890abcdef1234567890abcdef12345678");

let target: Env;
let clock: ReturnType<typeof frozenClock>;
let minute = 0;

beforeEach(async () => {
  await resetDb();
  // A minute of its own for every test, so that none sees another's cached answer.
  clock = frozenClock(NOW + 60 * ++minute);
  target = chainEnv();
});

afterEach(() => {
  setClock(null);
  setCheckRuntime(null);
  vi.restoreAllMocks();
});

/** The fake chain answers every request of a check; Sourcify's real URL goes to its fake Sourcify. */
function install(scenario: Scenario = {}, wrap: (fetch: FetchLike) => FetchLike = (fetch) => fetch) {
  const chain = fakeChain(scenario);
  const fetch: FetchLike = (url, init) => chain.fetch(url.replace("https://sourcify.dev/server/", "https://sourcify.test/server/"), init);
  setCheckRuntime({ fetch: wrap(fetch) });
  return { fetch, calls: chain.calls };
}

function get(token: string, headers: Record<string, string> = {}) {
  return call(target, `/v1/check/${token}`, { headers });
}

async function error(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/** Addresses with code but no token behind them on the fake chain. */
const other = (n: number) => `0x${"ab".repeat(19)}${n.toString(16).padStart(2, "0")}`;

describe("GET /v1/check/:token", () => {
  it("answers the report of @hyvo/check, with the block in its disclaimer", async () => {
    const { fetch, calls } = install();
    const response = await get(TOKEN.toLowerCase());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("X-Hyvo-Cache")).toBe("miss");
    const rpcRequests = calls.filter((c) => c.url === RPC).length;
    const body = (await response.json()) as Record<string, any>;

    expect(body.disclaimer).toBe(DISCLAIMER);
    expect(body.checkedAt).toBe(iso(clock.now()));
    expect(body.notice).toBe(CHECK_NOTICE);
    expect(body.token).toMatchObject({ address: TOKEN, symbol: "TT", decimals: 18, totalSupply: (10n ** 27n).toString() });
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual(CHECK_ORDER);
    expect(body.exit).toMatchObject({ venue: { kind: "v2", pair: PAIR }, buy: { ok: true, arrived: PLAIN_RESULT.gotBuy.toString() } });
    // Holders need Blockscout, which this API never asks, and the answer says so.
    expect(body.findings.find((f: { id: string }) => f.id === "holders").status).toBe("skipped");
    expect(body.skippedByApi).toEqual([{ id: "holders", reason: expect.stringContaining("Blockscout") }]);
    expect(calls.some((c) => c.url.includes("blockscout"))).toBe(false);
    // One RPC and one Sourcify request per call, far inside the 50 subrequests a free-plan request may make.
    expect(body.timings.requests).toEqual({ rpc: rpcRequests, sourcify: 1, blockscout: 0 });
    expect(rpcRequests).toBeLessThanOrEqual(10);

    // The same report as the package's, bigints as decimal strings; only the timings differ.
    const { checkedAt: _checkedAt, skippedByApi: _skipped, disclaimer: _disclaimer, timings: _timings, ...report } = body;
    const { timings: _direct, ...direct } = serializeReport(await checkToken(TOKEN, { rpcUrls: [RPC], fetch }));
    expect(report).toEqual(direct);
  });

  it("keeps an answer for the rest of the minute, then checks again", async () => {
    const { calls } = install();
    const first = await get(TOKEN);
    const made = calls.length;
    clock.advance(59);
    const second = await get(TOKEN.toLowerCase());
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Hyvo-Cache")).toBe("hit");
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=1");
    expect(await second.text()).toBe(await first.text());
    expect(calls.length).toBe(made);

    clock.advance(1);
    const third = await get(TOKEN);
    expect(third.headers.get("X-Hyvo-Cache")).toBe("miss");
    expect(third.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(((await third.json()) as { checkedAt: string }).checkedAt).toBe(iso(clock.now()));
    expect(calls.length).toBeGreaterThan(made);
  });

  it("answers CORS for the web app, from the cache too", async () => {
    install();
    const origin = target.WEB_ORIGIN;
    const miss = await get(TOKEN, { Origin: origin });
    expect(miss.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const hit = await get(`0x${TOKEN.slice(2).toUpperCase()}`, { Origin: origin });
    expect(hit.headers.get("X-Hyvo-Cache")).toBe("hit");
    expect(hit.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect((await get(TOKEN, { Origin: "https://evil.example" })).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("limits the checks an IP starts, not the answers it gets from the cache", async () => {
    install();
    expect((await get(TOKEN)).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await get(TOKEN)).headers.get("X-Hyvo-Cache")).toBe("hit");
    for (let i = 1; i < CHECKS_PER_MINUTE; i++) expect((await get(other(i))).status).toBe(404);
    const limited = await get(other(99));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await error(limited)).code).toBe("rate_limited");
    // The cached answer still comes back, and another IP has its own limit.
    expect((await get(TOKEN)).status).toBe(200);
    expect((await get(other(98), { "CF-Connecting-IP": "203.0.113.9" })).status).toBe(404);
  });

  it("refuses what is not an address before asking the chain", async () => {
    const { calls } = install();
    for (const bad of ["0x1234", "nope", `${TOKEN}00`, `0x${"g".repeat(40)}`]) {
      const response = await get(bad);
      expect(response.status).toBe(400);
      expect(await error(response)).toEqual({ code: "bad_request", message: "not an address: expected 0x and 40 hex characters" });
    }
    expect(calls).toHaveLength(0);
  });

  it("says when there is no token at the address, and asks again next time", async () => {
    const { calls } = install({ code: "0x" });
    const none = await get(TOKEN);
    expect(none.status).toBe(404);
    expect(await error(none)).toEqual({ code: "not_a_contract", message: expect.stringContaining("has no code at block 254") });
    const made = calls.length;
    expect((await get(TOKEN)).status).toBe(404); // not cached: a token deployed a moment later is found
    expect(calls.length).toBeGreaterThan(made);

    install({ view: (t) => (t.toLowerCase() === TOKEN.toLowerCase() ? null : undefined) });
    const notToken = await get(TOKEN);
    expect(notToken.status).toBe(404);
    expect((await error(notToken)).code).toBe("not_a_token");
  });

  it("answers 503 when the chain cannot be read, and 504 when it is too slow", async () => {
    install({ chainId: "0x1" });
    const wrong = await get(TOKEN);
    expect(wrong.status).toBe(503);
    expect(await error(wrong)).toEqual({ code: "chain_unavailable", message: expect.stringContaining("chain 1") });

    target = chainEnv({ RPC_URLS: "https://down.test" });
    install();
    const down = await get(TOKEN);
    expect(down.status).toBe(503);
    expect(down.headers.get("Retry-After")).toBe("10");
    expect(await error(down)).toEqual({ code: "chain_unavailable", message: "Robinhood Chain could not be read right now; ask again shortly" });

    target = chainEnv();
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    setCheckRuntime({ fetch: hang, deadlineMs: 50 });
    const slow = await get(TOKEN);
    expect(slow.status).toBe(504);
    expect((await error(slow)).code).toBe("check_timeout");
  });

  it("is off without RPC_URLS, or for another chain", async () => {
    const { calls } = install();
    for (const off of [chainEnv({ RPC_URLS: "" }), chainEnv({ CHAIN_ID: "46630" })]) {
      target = off;
      const response = await get(TOKEN);
      expect(response.status).toBe(503);
      expect((await error(response)).code).toBe("check_disabled");
    }
    expect(calls).toHaveLength(0);
  });

  it(
    "stays inside the free plan's 50 subrequests when every call needs the last try",
    async () => {
      // Three URLs, of which a check uses two. Every call answers only on its third try, the last the client makes
      // (the first URL, the second, the first again). The token is an EIP-1967 proxy and the probe returns nothing,
      // so the check makes every call it can: 11 calls, 33 requests, and Sourcify for the token and the
      // implementation. The Cache API's match and put share the quota.
      const cacheCalls = [vi.spyOn(caches.default, "match"), vi.spyOn(caches.default, "put")];
      target = chainEnv({ RPC_URLS: "http://a.test,http://b.test,http://c.test" });
      const tries = new Map<string, number>();
      const sent: string[] = [];
      install({ probeResult: "empty" }, (fetch) => async (url, init) => {
        sent.push(url);
        if (url.startsWith("https://sourcify.dev/")) return fetch(url, init);
        const { id, method, params } = JSON.parse(init.body ?? "{}") as { id: number; method: string; params: unknown[] };
        const key = `${method} ${JSON.stringify(params)}`;
        const attempt = (tries.get(key) ?? 0) + 1;
        tries.set(key, attempt);
        if (attempt < RPC_ATTEMPTS) return { ok: false, status: 503, text: async () => "busy" };
        if (method === "eth_getStorageAt" && params[1] === IMPLEMENTATION_SLOT) {
          const word = `0x${IMPLEMENTATION.slice(2).toLowerCase().padStart(64, "0")}`;
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id, result: word }) };
        }
        return fetch(url, init);
      });

      const response = await get(TOKEN);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(body.code.proxyImplementation).toBe(IMPLEMENTATION);
      expect(body.findings.find((f: { id: string }) => f.id === "sell-simulation")).toMatchObject({ status: "skipped" });
      expect([...tries.values()].every((n) => n === RPC_ATTEMPTS)).toBe(true);
      expect(tries.size).toBe(11);
      expect(body.timings.requests).toEqual({ rpc: 11 * RPC_ATTEMPTS, sourcify: 2, blockscout: 0 });
      expect(sent).toHaveLength(35);
      expect(sent).not.toContain("http://c.test");
      const cached = cacheCalls.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      expect(cached).toBe(2);
      expect(sent.length + cached).toBeLessThanOrEqual(50);
    },
    20_000,
  );
});

describe("check_token over MCP", () => {
  async function tool(args: unknown) {
    const response = await call(target, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_token", arguments: args } }),
    });
    expect(response.status).toBe(200);
    const { result, error: rpcError } = (await response.json()) as { result?: any; error?: unknown };
    expect(rpcError).toBeUndefined();
    return result as { content: { type: string; text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };
  }

  it("answers the route's report from the same cache, with no key", async () => {
    const { calls } = install();
    const result = await tool({ address: TOKEN });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.disclaimer).toBe(DISCLAIMER);
    expect(result.structuredContent?.findings).toHaveLength(CHECK_ORDER.length);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    const made = calls.length;
    const route = await get(TOKEN);
    expect(route.headers.get("X-Hyvo-Cache")).toBe("hit");
    expect(await route.json()).toEqual(result.structuredContent);
    expect(calls.length).toBe(made);
  });

  it("says what it cannot check in a way a model can act on", async () => {
    install({ code: "0x" });
    const cases: [unknown, string][] = [
      [{ address: "0x1234" }, "not an address"],
      [{}, "address"],
      [{ address: TOKEN }, "has no code at block 254"],
    ];
    for (const [args, text] of cases) {
      const result = await tool(args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(text);
    }
  });

  it("is listed as a read-only tool that needs an address", async () => {
    const listed = TOOLS.find((t) => t.name === "check_token");
    expect(listed?.inputSchema).toMatchObject({ type: "object", required: ["address"] });
    expect(listed?.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("copy rules", () => {
  it("leave no word Hyvo never uses about a token in what this API adds", async () => {
    install();
    const texts = [
      await (await get(TOKEN)).text(),
      ...SKIPPED_BY_API.map((s) => s.reason),
      ...TOOLS.filter((t) => t.name === "check_token").flatMap((t) => [t.title, t.description, JSON.stringify(t.inputSchema)]),
    ];
    install({ code: "0x" });
    texts.push(await (await get(other(1))).text());
    for (const text of texts) expect(text).not.toMatch(BANNED);
  });
});
