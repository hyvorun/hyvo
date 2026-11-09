/**
 * Top holders from Blockscout's index with the Worker's key: `GET /v1/check/:token` and MCP's check_token fill the
 * holder and deployer findings, and `GET /v1/check/:token/holders` answers the facts alone. Run inside workerd
 * against the fake chain of @hyvo/check's tests and a fake Blockscout (no network). The key is a fake one, and the
 * last tests make sure it leaves the Worker only towards Blockscout.
 */
import { CHECK_ORDER, shortenAddress, type FetchLike } from "@hyvo/check";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER, PAIR, TOKEN, fakeChain, type Scenario } from "../../../packages/check/test/fake-chain";
import type { Env } from "../src/env";
import { RPC_ATTEMPTS, setCheckRuntime } from "../src/lib/check";
import { iso, setClock } from "../src/lib/clock";
import { BLOCKSCOUT_READS_PER_MINUTE, HOLDER_READS_PER_MINUTE, holdersSource, redact, setHoldersFetch } from "../src/lib/holders";
import { runScheduled } from "../src/scheduled";
import { call, chainEnv, frozenClock, resetDb } from "./helpers";

/** A fake key, made to stand out: it must never come back in an answer, a header or a log. */
const KEY = "proapi_FAKE-key/never+leaves=the.worker";
const NOW = 1_900_200_000; // the start of a ten-minute window
const BLOCKSCOUT = "https://api.blockscout.com/4663/api/v2";
const HOLDER = getAddress("0x1111111111111111111111111111111111111aaa");
const TX = `0x${"cd".repeat(32)}`;
const SUPPLY = 10n ** 27n;

let target: Env;
let clock: ReturnType<typeof frozenClock>;
let window = 0;

beforeEach(async () => {
  await resetDb();
  // A day of its own for every test (some move the clock on), so that none sees another's cached facts.
  clock = frozenClock(NOW + 86_400 * ++window);
  target = chainEnv({ BLOCKSCOUT_API_KEY: KEY });
});

afterEach(() => {
  setClock(null);
  setCheckRuntime(null);
  setHoldersFetch(null);
  vi.restoreAllMocks();
});

type Answer = { status: number; body: unknown } | "throw" | "hang";

interface Blockscout {
  token?: Answer;
  holders?: Answer;
  address?: Answer;
}

/** The fake chain, Sourcify, and a fake Blockscout that puts the key it was sent in every body it answers. */
function install(scenario: Scenario = {}, blockscout: Blockscout = {}) {
  const chain = fakeChain(scenario);
  const fetch: FetchLike = (url, init) => chain.fetch(url.replace("https://sourcify.dev/server/", "https://sourcify.test/server/"), init);
  setCheckRuntime({ fetch });
  const asked: string[] = [];
  const bs: FetchLike = async (url, init) => {
    asked.push(url);
    const { pathname, searchParams } = new URL(url);
    const sent = searchParams.get("apikey");
    const answer: Answer = pathname.endsWith("/holders")
      ? (blockscout.holders ?? {
          status: 200,
          body: {
            items: [
              { address: { hash: PAIR.toLowerCase(), name: `pool ${sent}` }, value: (5n * 10n ** 26n).toString() },
              { address: { hash: HOLDER.toLowerCase() }, value: (2n * 10n ** 26n).toString() },
              { address: { hash: OWNER.toLowerCase() }, value: (10n ** 26n).toString() },
            ],
            next_page_params: { key: sent },
          },
        })
      : pathname.includes("/tokens/")
        ? (blockscout.token ?? { status: 200, body: { total_supply: SUPPLY.toString(), holders_count: "3", name: sent } })
        : (blockscout.address ?? { status: 200, body: { creator_address_hash: OWNER.toLowerCase(), creation_transaction_hash: TX, note: sent } });
    if (answer === "throw") throw new TypeError(`fetch failed: ${url}`);
    if (answer === "hang") {
      return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error(`aborted ${url}`))));
    }
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return { ok: answer.status === 200, status: answer.status, text: async () => body };
  };
  setHoldersFetch(bs);
  return { calls: chain.calls, asked };
}

function get(path: string, headers: Record<string, string> = {}) {
  return call(target, path, { headers });
}

function finding(body: Record<string, any>, id: string) {
  return body.findings.find((f: { id: string }) => f.id === id) as { status: string; evidence: string };
}

async function error(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

const other = (n: number) => `0x${"cd".repeat(19)}${n.toString(16).padStart(2, "0")}`;

describe("GET /v1/check/:token with a Blockscout key", () => {
  it("fills the top holders, leaving the venue's pair out, and says where the balances came from", async () => {
    const { calls, asked } = install();
    const response = await get(`/v1/check/${TOKEN.toLowerCase()}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.findings.map((f: { id: string }) => f.id)).toEqual(CHECK_ORDER);
    expect(body.skippedByApi).toEqual([]);
    const holders = finding(body, "holders");
    expect(holders.status).toBe("found");
    expect(holders.evidence).toContain("the 2 largest holders hold 30% of the supply");
    expect(holders.evidence).toContain("the Uniswap V2 pair");
    expect(holders.evidence).toContain("3 holders in all");
    expect(holders.evidence).toContain(`the deployer ${shortenAddress(OWNER)} holds 10%`);
    expect(holders.evidence).toContain(`balances from ${holdersSource(clock.now())}, not read at block 254`);
    // Sourcify names the deployer first; Blockscout's creator is the fallback.
    expect(finding(body, "deployer").evidence).toContain("(Sourcify)");
    expect(body.disclaimer).toBe("Measured on-chain at block 254. Not a trading signal.");

    // Three requests to Blockscout, the key in their query; nothing else hears of it.
    expect(asked.map((url) => new URL(url).pathname).sort()).toEqual([
      `/4663/api/v2/addresses/${TOKEN}`,
      `/4663/api/v2/tokens/${TOKEN}`,
      `/4663/api/v2/tokens/${TOKEN}/holders`,
    ]);
    expect(asked.every((url) => url.startsWith(BLOCKSCOUT) && new URL(url).searchParams.get("apikey") === KEY)).toBe(true);
    expect(calls.some((c) => c.url.includes(encodeURIComponent(KEY)) || c.url.includes(KEY))).toBe(false);
  });

  it("names Blockscout's creator when no launch record or Sourcify does", async () => {
    install({ sourcify: { status: 404, body: { match: null } } });
    const body = (await (await get(`/v1/check/${TOKEN}`)).json()) as Record<string, any>;
    expect(finding(body, "deployer")).toEqual(
      expect.objectContaining({
        status: "found",
        evidence: `created by ${shortenAddress(OWNER)} in transaction ${TX.slice(0, 10)}…${TX.slice(-4)} (${holdersSource(clock.now())}); no Pons launch record`,
      }),
    );
  });

  it("keeps Blockscout's facts for ten minutes, across checks", async () => {
    const { asked } = install();
    expect((await get(`/v1/check/${TOKEN}`)).status).toBe(200);
    expect(asked).toHaveLength(3);
    clock.advance(60); // the check's own minute is over: a new check, the same holder facts
    const again = (await (await get(`/v1/check/${TOKEN}`)).json()) as Record<string, any>;
    expect(again.checkedAt).toBe(iso(clock.now()));
    expect(asked).toHaveLength(3);
    expect(finding(again, "holders").evidence).toContain(holdersSource(clock.now() - 60));
    clock.advance(540); // a new window
    await get(`/v1/check/${TOKEN}`);
    expect(asked).toHaveLength(6);
  });

  it("leaves the holders skipped, with a plain reason, when Blockscout answers 429 or fails, and asks again next time", async () => {
    const { asked } = install({}, { holders: { status: 429, body: { message: "Too Many Requests" } }, address: "throw" });
    const body = (await (await get(`/v1/check/${TOKEN}`)).json()) as Record<string, any>;
    expect(finding(body, "holders")).toEqual({
      id: "holders",
      title: "Top holders",
      status: "skipped",
      evidence: "Blockscout's API answered 429 for the token's holders: its free tier allows 5 requests a second",
    });
    expect(finding(body, "deployer").status).toBe("found"); // Sourcify
    clock.advance(60);
    await get(`/v1/check/${TOKEN}`);
    expect(asked).toHaveLength(6); // not kept

    install({}, { token: "hang", holders: "hang", address: "hang" });
    clock.advance(60);
    const slow = (await (await get(`/v1/check/${TOKEN}`)).json()) as Record<string, any>;
    expect(finding(slow, "holders").evidence).toBe("Blockscout's API did not answer in time for the token's holders");
  }, 20_000);

  it("leaves the holders skipped when Blockscout's page lists none, and does not keep that answer", async () => {
    const { asked } = install({}, { holders: { status: 200, body: { items: [], next_page_params: null } } });
    const body = (await (await get(`/v1/check/${TOKEN}`)).json()) as Record<string, any>;
    expect(finding(body, "holders")).toMatchObject({ status: "skipped", evidence: "Blockscout's index lists no holders for the token yet" });
    clock.advance(60);
    await get(`/v1/check/${TOKEN}`);
    expect(asked).toHaveLength(6); // asked again: an empty page is not kept for the window
  });

  it("answers as today without a key", async () => {
    target = chainEnv();
    const { asked } = install();
    const body = (await (await get(`/v1/check/${TOKEN}`)).json()) as Record<string, any>;
    expect(finding(body, "holders").status).toBe("skipped");
    expect(finding(body, "holders").evidence).toContain("Blockscout API key");
    expect(body.skippedByApi).toEqual([{ id: "holders", reason: expect.stringContaining("Blockscout") }]);
    expect(asked).toHaveLength(0);
  });

  it(
    "stays inside the free plan's 50 subrequests with Blockscout's three and the Cache API's four",
    async () => {
      // As in check.test.ts: every chain call answers only on its last try, the token is a proxy and the probe returns
      // nothing, so the check makes all the requests it can. Blockscout adds 3, and the Cache API, whose calls share
      // the quota on the free plan, 4: a match and a put for the check's answer and for the holder facts.
      const cacheCalls = [vi.spyOn(caches.default, "match"), vi.spyOn(caches.default, "put")];
      target = chainEnv({ BLOCKSCOUT_API_KEY: KEY, RPC_URLS: "http://a.test,http://b.test,http://c.test" });
      const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
      const implementation = getAddress("0x1234567890abcdef1234567890abcdef12345678");
      const tries = new Map<string, number>();
      const sent: string[] = [];
      const { asked } = install({ probeResult: "empty" });
      const chain = fakeChain({ probeResult: "empty" });
      setCheckRuntime({
        fetch: async (url, init) => {
          sent.push(url);
          if (url.startsWith("https://sourcify.dev/")) return chain.fetch(url.replace("https://sourcify.dev/server/", "https://sourcify.test/server/"), init);
          const { id, method, params } = JSON.parse(init.body ?? "{}") as { id: number; method: string; params: unknown[] };
          const key = `${method} ${JSON.stringify(params)}`;
          const attempt = (tries.get(key) ?? 0) + 1;
          tries.set(key, attempt);
          if (attempt < RPC_ATTEMPTS) return { ok: false, status: 503, text: async () => "busy" };
          if (method === "eth_getStorageAt" && params[1] === IMPLEMENTATION_SLOT) {
            const word = `0x${implementation.slice(2).toLowerCase().padStart(64, "0")}`;
            return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id, result: word }) };
          }
          return chain.fetch(url, init);
        },
      });
      const response = await get(`/v1/check/${TOKEN}`);
      expect(response.status).toBe(200);
      expect(tries.size).toBe(11);
      expect([...tries.values()].every((n) => n === RPC_ATTEMPTS)).toBe(true);
      expect(sent).toHaveLength(11 * RPC_ATTEMPTS + 2);
      expect(asked).toHaveLength(3);
      const cached = cacheCalls.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      expect(cached).toBe(4);
      expect(sent.length + asked.length + cached).toBe(42);
      expect(sent.length + asked.length + cached).toBeLessThanOrEqual(50);
    },
    20_000,
  );
});

describe("GET /v1/check/:token/holders", () => {
  it("answers the facts, where and when they were read, with CORS for the web app", async () => {
    install();
    const origin = target.WEB_ORIGIN;
    const response = await get(`/v1/check/${TOKEN.toLowerCase()}/holders`, { Origin: origin });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(response.headers.get("X-Hyvo-Cache")).toBe("miss");
    expect(await response.json()).toEqual({
      token: TOKEN,
      source: holdersSource(clock.now()),
      totalSupply: SUPPLY.toString(),
      holderCount: 3,
      holders: [
        { address: PAIR, value: (5n * 10n ** 26n).toString() },
        { address: HOLDER, value: (2n * 10n ** 26n).toString() },
        { address: OWNER, value: (10n ** 26n).toString() },
      ],
      holdersMissing: null,
      creator: { address: OWNER, creationTxHash: TX },
      creatorMissing: null,
      readAt: iso(clock.now()),
      disclaimer: `Read from Blockscout's index through Hyvo's API at ${iso(clock.now())}, not at one block. Not a trading signal.`,
    });

    clock.advance(599);
    const hit = await get(`/v1/check/${TOKEN}/holders`, { Origin: origin });
    expect(hit.headers.get("X-Hyvo-Cache")).toBe("hit");
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=1");
    expect(hit.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect((await get(`/v1/check/${TOKEN}/holders`, { Origin: "https://evil.example" })).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("says what Blockscout did not answer, and keeps none of it", async () => {
    const { asked } = install({}, { holders: { status: 429, body: {} }, address: { status: 500, body: "<html>oops</html>" } });
    const response = await get(`/v1/check/${TOKEN}/holders`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, any>;
    expect(body.holders).toBeNull();
    expect(body.holdersMissing).toBe("Blockscout's API answered 429 for the token's holders: its free tier allows 5 requests a second");
    expect(body.creator).toBeNull();
    expect(body.creatorMissing).toBe("Blockscout's API answered 500 for the token's creator");
    clock.advance(30); // past the pause a 429 starts, inside the same ten-minute window
    await get(`/v1/check/${TOKEN}/holders`);
    expect(asked).toHaveLength(6);
  });

  it("asks Blockscout nothing for 30 s after it answers 429, then asks again", async () => {
    const { asked } = install({}, { holders: { status: 429, body: {} } });
    await get(`/v1/check/${TOKEN}/holders`);
    expect(asked).toHaveLength(3);
    const paused = await get(`/v1/check/${other(1)}/holders`);
    expect(paused.status).toBe(200);
    expect(paused.headers.get("Cache-Control")).toBe("no-store");
    const body = (await paused.json()) as Record<string, any>;
    expect(body.holdersMissing).toBe("Blockscout's API answered 429 to Hyvo's API in the last 30 s; ask again in 30 s");
    expect(body.creatorMissing).toBe(body.holdersMissing);
    clock.advance(10);
    expect(((await (await get(`/v1/check/${other(2)}/holders`)).json()) as Record<string, any>).holdersMissing).toMatch(/ask again in 20 s$/);
    expect(asked).toHaveLength(3);
    clock.advance(20);
    await get(`/v1/check/${other(3)}/holders`);
    expect(asked).toHaveLength(6);
  });

  it("stops reading Blockscout for the day after 30,000 reads, a count the cron keeps all day", async () => {
    const { asked } = install();
    const now = clock.now();
    const day = now - (now % 86_400);
    expect(now - day).toBeGreaterThan(3_600); // more than an hour into the UTC day
    const seed = (key: string, start: number, count: number) =>
      target.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)").bind(key, start, count).run();
    await seed(`blockscout-day:worker:${day}`, day, 30_000);
    await seed(`blockscout:worker:${now - 7_200}`, now - 7_200, 5);
    // The cron drops the counts of minutes past, not the day's.
    await runScheduled(chainEnv({ BLOCKSCOUT_API_KEY: KEY, RPC_URLS: "" }), now);
    const kept = await target.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>();
    expect(kept.results.map((row) => row.key)).toEqual([`blockscout-day:worker:${day}`]);

    const spent = await get(`/v1/check/${TOKEN}/holders`);
    expect(spent.status).toBe(200);
    const body = (await spent.json()) as Record<string, any>;
    expect(body.holders).toBeNull();
    expect(body.holdersMissing).toBe("Hyvo's API has read Blockscout's index as often as it may today; ask again after 00:00 UTC");
    expect(asked).toHaveLength(0);
    // A check still answers, with the holders skipped and why.
    const check = (await (await get(`/v1/check/${TOKEN}`)).json()) as Record<string, any>;
    expect(finding(check, "holders")).toMatchObject({ status: "skipped", evidence: body.holdersMissing });
    expect(asked).toHaveLength(0);
  });

  it("refuses what is not an address, and is off without a key", async () => {
    const { asked } = install();
    const bad = await get("/v1/check/0x1234/holders");
    expect(bad.status).toBe(400);
    expect((await error(bad)).code).toBe("bad_request");
    target = chainEnv();
    const off = await get(`/v1/check/${TOKEN}/holders`);
    expect(off.status).toBe(503);
    expect(await error(off)).toEqual({ code: "holders_disabled", message: "top holders are not read on this API: it has no Blockscout key" });
    expect(asked).toHaveLength(0);
  });

  it("limits the reads an IP starts, not the answers it gets from the cache, and the Worker's reads a minute", async () => {
    const { asked } = install();
    expect((await get(`/v1/check/${TOKEN}/holders`)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await get(`/v1/check/${TOKEN}/holders`)).headers.get("X-Hyvo-Cache")).toBe("hit");
    for (let i = 1; i < HOLDER_READS_PER_MINUTE; i++) expect((await get(`/v1/check/${other(i)}/holders`)).status).toBe(200);
    const limited = await get(`/v1/check/${other(99)}/holders`);
    expect(limited.status).toBe(429);
    expect((await error(limited)).code).toBe("rate_limited");
    expect(asked).toHaveLength(3 * HOLDER_READS_PER_MINUTE);

    // Other IPs, until the Worker has read Blockscout BLOCKSCOUT_READS_PER_MINUTE times this minute.
    let n = 100;
    for (let read = HOLDER_READS_PER_MINUTE; read < BLOCKSCOUT_READS_PER_MINUTE; read++) {
      const ip = `203.0.113.${Math.floor(read / HOLDER_READS_PER_MINUTE)}`;
      expect((await get(`/v1/check/${other(n++)}/holders`, { "CF-Connecting-IP": ip })).status).toBe(200);
    }
    const spent = await get(`/v1/check/${other(n++)}/holders`, { "CF-Connecting-IP": "198.51.100.1" });
    expect(spent.status).toBe(200);
    const body = (await spent.json()) as Record<string, any>;
    expect(body.holdersMissing).toMatch(/^Hyvo's API has read Blockscout's index as often as it may this minute; ask again in \d+ s$/);
    expect(asked).toHaveLength(3 * BLOCKSCOUT_READS_PER_MINUTE);
  }, 30_000);
});

describe("the key", () => {
  it("is taken out of anything logged", () => {
    expect(redact(`https://x.test/?apikey=${encodeURIComponent(KEY)} and ${KEY}`, KEY)).toBe("https://x.test/?apikey=[key] and [key]");
    expect(redact("nothing", null)).toBe("nothing");
  });

  it("never comes back in an answer, a header or a log, on success or on any error", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const seen: string[] = [];
    const keep = async (response: Response) => {
      seen.push(`${response.status} ${[...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${await response.text()}`);
    };
    const mcp = (args: unknown) =>
      call(target, "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_token", arguments: args } }),
      });
    const next = () => clock.advance(600);

    // Success, through every route.
    install();
    await keep(await get(`/v1/check/${TOKEN}`));
    await keep(await get(`/v1/check/${TOKEN}/holders`));
    await keep(await mcp({ address: TOKEN }));
    // Blockscout fails every way it can: each answer and each error carries the key.
    const failures: Blockscout[] = [
      { token: "throw", holders: "throw", address: "throw" },
      { token: { status: 429, body: `${KEY} 429` }, holders: { status: 429, body: { error: KEY } }, address: { status: 429, body: KEY } },
      { token: { status: 402, body: { error: `bad key ${KEY}` } }, holders: { status: 401, body: KEY }, address: { status: 403, body: KEY } },
      { token: { status: 500, body: `<pre>${KEY}</pre>` }, holders: { status: 502, body: KEY }, address: { status: 404, body: KEY } },
      { token: { status: 200, body: "not json" }, holders: { status: 200, body: { items: [{ address: { hash: KEY }, value: KEY }] } }, address: { status: 200, body: { creator_address_hash: KEY, creation_transaction_hash: KEY } } },
      { token: "hang", holders: "hang", address: "hang" },
    ];
    for (const failure of failures) {
      next();
      install({}, failure);
      await keep(await get(`/v1/check/${TOKEN}`));
      await keep(await get(`/v1/check/${TOKEN}/holders`));
      await keep(await mcp({ address: TOKEN }));
    }
    // Every error of the routes themselves.
    next();
    install();
    await keep(await get("/v1/check/0x1234"));
    await keep(await get("/v1/check/0x1234/holders"));
    await keep(await mcp({ address: "nope" }));
    install({ code: "0x" });
    await keep(await get(`/v1/check/${other(1)}`));
    install({ view: (t) => (t.toLowerCase() === TOKEN.toLowerCase() ? null : undefined) });
    next();
    await keep(await get(`/v1/check/${TOKEN}`));
    install({ chainId: "0x1" });
    next();
    await keep(await get(`/v1/check/${TOKEN}`));
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    setCheckRuntime({ fetch: hang, deadlineMs: 50 });
    next();
    await keep(await get(`/v1/check/${TOKEN}`));
    target = chainEnv({ BLOCKSCOUT_API_KEY: KEY, RPC_URLS: "" });
    await keep(await get(`/v1/check/${TOKEN}`));
    target = chainEnv({ BLOCKSCOUT_API_KEY: KEY });
    install();
    next();
    for (let i = 0; i <= HOLDER_READS_PER_MINUTE; i++) await keep(await get(`/v1/check/${other(i + 10)}/holders`));
    for (let i = 0; i < 12; i++) await keep(await get(`/v1/check/${other(i + 40)}`));

    const statuses = new Set(seen.map((text) => Number(text.slice(0, 3))));
    for (const status of [200, 400, 404, 429, 503, 504]) expect(statuses).toContain(status);
    const encoded = encodeURIComponent(KEY);
    for (const text of [...seen, ...logged]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(encoded);
      expect(text).not.toContain("proapi_FAKE");
    }
    expect(logged.length).toBeGreaterThan(0);
  }, 60_000);
});
