// Holder facts read apart from the check: Blockscout's index through readHolderFacts, their JSON round trip, and
// checkToken taking them through `options.holders`. No network.
import { describe, expect, it } from "vitest";
import { checkToken, parseHolderFacts, readHolderFacts, serializeHolderFacts, type FetchLike, type HolderFacts } from "../src/index";
import { shortenAddress, toChecksumAddress } from "../src/chain/abi";
import { OPTIONS, OWNER, PAIR, TOKEN, fakeChain } from "./fake-chain";

const KEY = "proapi_FAKE_KEY_for_tests_only";
const SOURCE = "Blockscout's index, read through Hyvo's API at 07:12 UTC on 2026-11-09";
const HOLDER_A = "0x1111111111111111111111111111111111111aaa";
const HOLDER_B = "0x2222222222222222222222222222222222222bbb";
const TX = `0x${"cd".repeat(32)}`;

type Answer = { status: number; body: unknown } | "throw";

/** A fake Blockscout keyed API: one answer per route. */
function fakeBlockscout(answers: { token?: Answer; holders?: Answer; address?: Answer } = {}) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const answer: Answer = path.endsWith("/holders")
      ? (answers.holders ?? {
          status: 200,
          body: {
            items: [
              { address: { hash: PAIR.toLowerCase() }, value: "500" },
              { address: { hash: HOLDER_A }, value: "200" },
              { address: { hash: OWNER.toLowerCase() }, value: "50" },
              { address: { hash: "nope" }, value: "1" },
              { address: { hash: HOLDER_B }, value: "-3" },
            ],
            next_page_params: null,
          },
        })
      : path.includes("/tokens/")
        ? (answers.token ?? { status: 200, body: { total_supply: "1000", holders_count: "4" } })
        : (answers.address ?? { status: 200, body: { creator_address_hash: OWNER.toLowerCase(), creation_transaction_hash: TX } });
    if (answer === "throw") throw new TypeError(`fetch failed for ${url}`);
    return { ok: answer.status === 200, status: answer.status, text: async () => JSON.stringify(answer.body) };
  };
  return { fetch, urls };
}

describe("readHolderFacts", () => {
  it("reads the totals, the holders and the creator in three requests, keeping only well-formed rows", async () => {
    const { fetch, urls } = fakeBlockscout();
    const facts = await readHolderFacts(TOKEN.toLowerCase(), { blockscoutKey: KEY, fetch, source: SOURCE, blockscoutUrl: "https://bs.test/4663/api" });
    expect(facts).toEqual({
      source: SOURCE,
      totalSupply: 1000n,
      holderCount: 4,
      holders: [
        { address: PAIR, value: 500n },
        { address: toChecksumAddress(HOLDER_A), value: 200n },
        { address: OWNER, value: 50n },
      ],
      holdersMissing: null,
      creator: { address: OWNER, creationTxHash: TX },
      creatorMissing: null,
      requests: 3,
    });
    expect(urls.map((u) => new URL(u).pathname).sort()).toEqual([
      `/4663/api/v2/addresses/${TOKEN}`,
      `/4663/api/v2/tokens/${TOKEN}`,
      `/4663/api/v2/tokens/${TOKEN}/holders`,
    ]);
    expect(urls.every((u) => new URL(u).searchParams.get("apikey") === KEY)).toBe(true);
  });

  it("says why a part is missing, and never retries a 429 unless asked", async () => {
    const limited = fakeBlockscout({ holders: { status: 429, body: { message: `slow down ${KEY}` } }, address: "throw" });
    const facts = await readHolderFacts(TOKEN, { blockscoutKey: KEY, fetch: limited.fetch, source: SOURCE });
    expect(facts.holders).toBeNull();
    expect(facts.holdersMissing).toBe("Blockscout's API answered 429 for the token's holders: its free tier allows 5 requests a second");
    expect(facts.creator).toBeNull();
    expect(facts.creatorMissing).toBe("Blockscout's API could not be reached for the token's creator");
    expect(facts.totalSupply).toBe(1000n);
    expect(limited.urls).toHaveLength(3);
    // The key, which a failing fetch can put in its message, reaches no reason.
    expect(JSON.stringify(serializeHolderFacts(facts))).not.toContain(KEY);

    const refused = fakeBlockscout({ token: { status: 402, body: {} }, holders: { status: 402, body: {} }, address: { status: 200, body: {} } });
    const none = await readHolderFacts(TOKEN, { blockscoutKey: KEY, fetch: refused.fetch, source: SOURCE });
    expect(none.holdersMissing).toBe("Blockscout's API refused the request for the token's holders");
    expect(none.creatorMissing).toBe("Blockscout's index names no creator for the token");
    expect(none.holderCount).toBeNull();
  });

  it("gives up on a request that takes too long", async () => {
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const facts = await readHolderFacts(TOKEN, { blockscoutKey: KEY, fetch: hang, source: SOURCE, timeoutMs: 20 });
    expect(facts.holdersMissing).toBe("Blockscout's API did not answer in time for the token's holders");
    expect(facts.creatorMissing).toBe("Blockscout's API did not answer in time for the token's creator");
  });
});

describe("holder facts as JSON", () => {
  const facts: HolderFacts = {
    source: SOURCE,
    totalSupply: 10n ** 27n,
    holderCount: 12,
    holders: [{ address: OWNER, value: 5n * 10n ** 26n }],
    holdersMissing: null,
    creator: { address: OWNER, creationTxHash: TX as `0x${string}` },
    creatorMissing: null,
  };

  it("round-trips", () => {
    const json = JSON.parse(JSON.stringify(serializeHolderFacts(facts)));
    expect(json.totalSupply).toBe("1000000000000000000000000000");
    expect(parseHolderFacts(json)).toEqual(facts);
  });

  it("is refused when any field is not what it should be", () => {
    const json = serializeHolderFacts(facts) as unknown as Record<string, unknown>;
    for (const broken of [
      null,
      "facts",
      { ...json, source: "" },
      { ...json, source: "line\nbreak" },
      { ...json, totalSupply: "12.5" },
      { ...json, holderCount: -1 },
      { ...json, holders: [{ address: "0x12", value: "1" }] },
      { ...json, holders: [{ address: OWNER, value: 1 }] },
      { ...json, creator: { address: OWNER, creationTxHash: "0x12" } },
    ]) {
      expect(parseHolderFacts(broken)).toBeNull();
    }
    // A missing part keeps its reason.
    expect(parseHolderFacts({ ...json, holders: null, holdersMissing: "Blockscout's API answered 429" })).toMatchObject({
      holders: null,
      holdersMissing: "Blockscout's API answered 429",
    });
  });
});

describe("checkToken with holder facts", () => {
  it("fills the holders, leaving the venue's pair out, and names where the balances came from", async () => {
    const { fetch, calls } = fakeChain();
    let asked = 0;
    const report = await checkToken(TOKEN, {
      ...OPTIONS,
      fetch,
      holders: async (token) => {
        asked++;
        expect(token).toBe(TOKEN);
        return {
          source: SOURCE,
          totalSupply: 2000n,
          holderCount: 4,
          holders: [
            { address: PAIR, value: 5n * 10n ** 26n },
            { address: OWNER, value: 10n ** 26n },
          ],
          holdersMissing: null,
          creator: null,
          creatorMissing: "Blockscout's index names no creator for the token",
        };
      },
    });
    expect(asked).toBe(1);
    expect(calls.some((c) => c.url.includes("blockscout"))).toBe(false);
    const holders = report.findings.find((f) => f.id === "holders")!;
    expect(holders.status).toBe("found");
    // The chain's supply at the block (10^27) comes first; the pair holds pool liquidity and is left out.
    expect(holders.evidence).toContain("the 1 largest holders hold 10% of the supply");
    expect(holders.evidence).toContain("the Uniswap V2 pair");
    expect(holders.evidence).toContain("4 holders in all");
    expect(holders.evidence).toContain(`the deployer ${shortenAddress(OWNER)} holds 10%`);
    expect(holders.evidence).toContain(`balances from ${SOURCE}, not read at block 254`);
    // Sourcify names the deployer first.
    expect(report.findings.find((f) => f.id === "deployer")!.evidence).toContain("(Sourcify)");
  });

  it("names the index's creator when nothing else does, with its source", async () => {
    const { fetch } = fakeChain({ sourcify: { status: 404, body: { match: null } } });
    const report = await checkToken(TOKEN, {
      ...OPTIONS,
      fetch,
      holders: async () => ({
        source: SOURCE,
        totalSupply: null,
        holderCount: null,
        holders: null,
        holdersMissing: "Blockscout's API answered 429 for the token's holders: its free tier allows 5 requests a second",
        creator: { address: OWNER, creationTxHash: TX as `0x${string}` },
        creatorMissing: null,
      }),
    });
    expect(report.findings.find((f) => f.id === "holders")).toMatchObject({
      status: "skipped",
      evidence: "Blockscout's API answered 429 for the token's holders: its free tier allows 5 requests a second",
    });
    expect(report.findings.find((f) => f.id === "deployer")).toMatchObject({
      status: "found",
      evidence: `created by ${shortenAddress(OWNER)} in transaction ${TX.slice(0, 10)}…${TX.slice(-4)} (${SOURCE}); no Pons launch record`,
    });
  });

  it("keeps the holder check skipped when the facts cannot be had", async () => {
    for (const holders of [async () => null, async () => Promise.reject(new Error("down")), () => { throw new Error("sync"); }]) {
      const { fetch } = fakeChain({ sourcify: { status: 404, body: { match: null } } });
      const report = await checkToken(TOKEN, { ...OPTIONS, fetch, holders: holders as never });
      expect(report.findings.find((f) => f.id === "holders")).toMatchObject({ status: "skipped", evidence: "the holder facts could not be read" });
      expect(report.findings.find((f) => f.id === "deployer")!.evidence).toContain("the holder facts could not be read");
    }
  });
});
