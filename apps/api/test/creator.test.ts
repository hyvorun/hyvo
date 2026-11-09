/**
 * `GET /v1/launches/creator/:address`: a wallet's Pons V2 launches from the factory's TokenLaunched logs in Blockscout's
 * index, read with the Worker's key. Run inside workerd against a fake Blockscout (no network). The key is a fake one,
 * and it must leave the Worker only towards Blockscout.
 */
import { addressTopic, LOGS_PER_PAGE, PONS_V2_FACTORY, PONS_V2_FACTORY_BLOCK } from "@hyvo/launches/creator";
import { CreatorLaunchesResponse } from "@hyvo/schema";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, toHex, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { iso, setClock } from "../src/lib/clock";
import { CREATOR_READS_PER_MINUTE, setCreatorFetch } from "../src/lib/creator";
import { setHoldersFetch } from "../src/lib/holders";
import { call, chainEnv, frozenClock, resetDb } from "./helpers";

const KEY = "proapi_FAKE-key/never+leaves=the.worker";
const NOW = 1_900_200_000;
const CREATOR = getAddress("0x2222222222222222222222222222222222222bbb");
const TOKEN_LAUNCHED = parseAbi([
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);

let target: Env;
let window = 0;

beforeEach(async () => {
  await resetDb();
  frozenClock(NOW + 86_400 * ++window);
  target = chainEnv({ BLOCKSCOUT_API_KEY: KEY });
});

afterEach(() => {
  setClock(null);
  setCreatorFetch(null);
  setHoldersFetch(null);
  vi.restoreAllMocks();
});

const word = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;

/** A TokenLaunched log as Blockscout's getLogs sends it. */
function log(n: number, block: bigint, deployer: string = CREATOR) {
  return {
    address: PONS_V2_FACTORY.toLowerCase(),
    topics: encodeEventTopics({ abi: TOKEN_LAUNCHED, eventName: "TokenLaunched", args: { token: word(0x1000 + n), curve: word(0x2000 + n), deployer: deployer as Hex } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [word(0), 1n, 4_200_000_000_000_000_000n]),
    blockNumber: toHex(block),
    timeStamp: toHex(1_794_000_000 + n),
    logIndex: "0x2",
    transactionHash: keccak256(toHex(`launch-${n}`)),
    transactionIndex: "0x1",
    gasPrice: "0x0",
    gasUsed: "0x0",
  };
}

type Answer = { status: number; body: unknown } | "throw";

/** A fake Blockscout answering each request with the next answer, and echoing the key it got. */
function install(answers: Answer[]) {
  const asked: URL[] = [];
  setCreatorFetch(async (url) => {
    const parsed = new URL(url);
    asked.push(parsed);
    const answer = answers.shift() ?? { status: 200, body: { status: "0", message: "No logs found", result: [] } };
    if (answer === "throw") throw new TypeError(`fetch failed: ${url}`);
    const body = JSON.stringify({ ...(answer.body as object), echo: parsed.searchParams.get("apikey") });
    return { status: answer.status, text: async () => body };
  });
  return asked;
}

const get = (path: string) => call(target, path);

describe("GET /v1/launches/creator/:address", () => {
  it("answers the wallet's launches from one getLogs query, newest first, and keeps them five minutes", async () => {
    const asked = install([{ status: 200, body: { status: "1", message: "OK", result: [log(1, 100_000_000n), log(2, 110_000_000n), log(3, 105_000_000n, word(0xbad))] } }]);
    const response = await get(`/v1/launches/creator/${CREATOR.toLowerCase()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Hyvo-Cache")).toBe("miss");
    expect(response.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+$/);
    const body = CreatorLaunchesResponse.parse(await response.json());
    expect(body.creator).toBe(CREATOR);
    expect(body.factory).toBe(PONS_V2_FACTORY);
    expect(body.complete).toBe(true);
    expect(body.missing).toBeNull();
    // Another deployer's log is dropped; the newest comes first.
    expect(body.launches?.map((launch) => launch.block)).toEqual([110_000_000, 100_000_000]);
    expect(body.launches?.[0]).toMatchObject({ token: getAddress(word(0x1002)), curve: getAddress(word(0x2002)), graduationThreshold: "4200000000000000000", timestamp: 1_794_000_002 });
    expect(body.disclaimer).toContain("Not a trading signal.");
    expect(body.readAt).toBe(iso(NOW + 86_400 * window));

    expect(asked).toHaveLength(1);
    const query = asked[0]!.searchParams;
    expect(asked[0]!.origin + asked[0]!.pathname).toBe("https://api.blockscout.com/4663/api");
    expect(query.get("module")).toBe("logs");
    expect(query.get("action")).toBe("getLogs");
    expect(query.get("address")).toBe(PONS_V2_FACTORY);
    expect(query.get("topic3")).toBe(addressTopic(CREATOR));
    expect(query.get("topic0_3_opr")).toBe("and");
    expect(query.get("fromBlock")).toBe(PONS_V2_FACTORY_BLOCK.toString());
    expect(query.get("apikey")).toBe(KEY);

    const again = await get(`/v1/launches/creator/${CREATOR}`);
    expect(again.headers.get("X-Hyvo-Cache")).toBe("hit");
    expect(asked).toHaveLength(1);
  });

  it("follows a full page from its last block, and merges the pages without doubles", async () => {
    const full = Array.from({ length: LOGS_PER_PAGE }, (_, i) => log(i, 100_000_000n + BigInt(i)));
    const asked = install([
      { status: 200, body: { status: "1", result: full } },
      { status: 200, body: { status: "1", result: [full.at(-1), log(5_000, 109_000_000n)] } },
    ]);
    const body = CreatorLaunchesResponse.parse(await (await get(`/v1/launches/creator/${CREATOR}`)).json());
    expect(asked).toHaveLength(2);
    expect(asked[1]!.searchParams.get("fromBlock")).toBe((100_000_000n + BigInt(LOGS_PER_PAGE - 1)).toString());
    expect(body.launches).toHaveLength(LOGS_PER_PAGE + 1);
    expect(body.complete).toBe(true);
  });

  it("stops after three pages and says the list may be incomplete", async () => {
    const page = (start: number) => ({ status: 200, body: { status: "1", result: Array.from({ length: LOGS_PER_PAGE }, (_, i) => log(start + i, BigInt(100_000_000 + start + i))) } });
    const asked = install([page(0), page(LOGS_PER_PAGE), page(2 * LOGS_PER_PAGE), page(3 * LOGS_PER_PAGE)]);
    const body = CreatorLaunchesResponse.parse(await (await get(`/v1/launches/creator/${CREATOR}`)).json());
    expect(asked).toHaveLength(3);
    expect(body.complete).toBe(false);
    expect(body.launches!.length).toBeGreaterThan(2 * LOGS_PER_PAGE);
  });

  it("answers a wallet with no launches with an empty list", async () => {
    install([{ status: 200, body: { status: "0", message: "No logs found", result: [] } }]);
    const body = CreatorLaunchesResponse.parse(await (await get(`/v1/launches/creator/${CREATOR}`)).json());
    expect(body.launches).toEqual([]);
    expect(body.complete).toBe(true);
  });

  it("says why when Blockscout does not answer, keeps nothing, and pauses after a 429", async () => {
    const asked = install([{ status: 429, body: { message: "Too Many Requests" } }]);
    const response = await get(`/v1/launches/creator/${CREATOR}`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = CreatorLaunchesResponse.parse(await response.json());
    expect(body.launches).toBeNull();
    expect(body.complete).toBe(false);
    expect(body.missing).toContain("429");
    // Paused: the next lookup asks Blockscout nothing.
    const next = CreatorLaunchesResponse.parse(await (await get(`/v1/launches/creator/${CREATOR}`)).json());
    expect(next.missing).toContain("ask again in");
    expect(asked).toHaveLength(1);

    install(["throw"]);
    const other = getAddress("0x3333333333333333333333333333333333333ccc");
    setHoldersFetch(null); // forget the pause
    const failed = CreatorLaunchesResponse.parse(await (await get(`/v1/launches/creator/${other}`)).json());
    expect(failed.missing).toBe("Blockscout's API could not be reached");
  });

  it("never sends the key back, in a body, a header or a log", async () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    install([{ status: 200, body: { status: "1", result: [log(1, 100_000_000n)] } }]);
    const response = await get(`/v1/launches/creator/${CREATOR}`);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("proapi_");
    expect([...response.headers.entries()].join(" ")).not.toContain("proapi_");
    expect(logged.join("\n")).not.toContain("proapi_");
    expect(logged.join("\n")).toContain('"event":"creator"');
  });

  it("refuses what is not an address, answers 503 without a key, and limits each IP", async () => {
    install([]);
    const bad = await get("/v1/launches/creator/0x1234");
    expect(bad.status).toBe(400);
    target = chainEnv({ BLOCKSCOUT_API_KEY: "" });
    const off = await get(`/v1/launches/creator/${CREATOR}`);
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("creator_disabled");

    target = chainEnv({ BLOCKSCOUT_API_KEY: KEY });
    const statuses: number[] = [];
    for (let i = 0; i <= CREATOR_READS_PER_MINUTE; i++) {
      // A different wallet each time, so none is answered from the cache.
      const response = await call(target, `/v1/launches/creator/0x${(0x4000 + i).toString(16).padStart(40, "0")}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, CREATOR_READS_PER_MINUTE).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
