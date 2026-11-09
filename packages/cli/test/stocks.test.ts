import { readFileSync } from "node:fs";
import { FEED_DIRECTORY_URL, SNAPSHOT } from "@hyvo/stocks";
import { describe, expect, it } from "vitest";
import { hasBannedWords } from "../../check/src/output/copy";
import { run, testContext, type Route } from "./helpers";

const RPC = "https://rpc.test";
const fixtures = new URL("../../stocks/test/fixtures/", import.meta.url);
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, fixtures), "utf8")) as T;

interface Recording {
  calls: { method: string; params: unknown; result: unknown }[];
}

const NVDA = SNAPSHOT.tokens.find((token) => token.symbol === "NVDA")!;

/** Answers JSON-RPC from a recording of the live chain (packages/stocks/test/fixtures), and nothing else. */
function replay(name: string): { route: Route; block: string } {
  const recording = fixture<Recording>(name);
  const answers = new Map(recording.calls.map((call) => [`${call.method} ${JSON.stringify(call.params)}`, call.result]));
  const route: Route = (url, body) => {
    if (url.origin !== RPC || !body) return undefined;
    const request = JSON.parse(body) as { id: number; method: string; params?: unknown };
    const key = `${request.method} ${JSON.stringify(request.params ?? [])}`;
    if (!answers.has(key)) return { body: { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: `not in the recording: ${key.slice(0, 120)}` } } };
    return { body: { jsonrpc: "2.0", id: request.id, result: answers.get(key) } };
  };
  const first = recording.calls[0]!.result as { number: string };
  return { route, block: BigInt(first.number).toString() };
}

const directory: Route = (url) => (url.href === FEED_DIRECTORY_URL ? { body: fixture<{ entries: unknown[] }>("feed-directory.subset.json").entries } : undefined);

/** The factory's nonce at a block, for the list's live check. */
function nonceRoute(nonce: number, block = 110_015_827): Route {
  return (url, body) => {
    if (url.origin !== RPC || !body) return undefined;
    const request = JSON.parse(body) as { id: number; method: string };
    if (request.method === "eth_blockNumber") return { body: { jsonrpc: "2.0", id: request.id, result: `0x${block.toString(16)}` } };
    if (request.method === "eth_getTransactionCount") return { body: { jsonrpc: "2.0", id: request.id, result: `0x${nonce.toString(16)}` } };
    return undefined;
  };
}

async function stocks(argv: string[], routes: Route[]) {
  const c = testContext({ routes });
  const code = await run(["stocks", ...argv], c);
  return { code, out: c.stdout(), err: c.stderr(), requests: c.requests };
}

describe("hyvo stocks <ticker|address>", () => {
  it("reads a registered token: the factory's record, its price, multiplier, flags and history", async () => {
    const { route, block } = replay("rpc-nvda.json");
    const { code, out, err, requests } = await stocks(["nvda", "--rpc", RPC], [route, directory]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("HYVO STOCKS   NVDA · NVIDIA");
    expect(out).toContain(`${NVDA.address} · block ${block}`);
    expect(out).toContain("Is this the NVDA stock token?");
    expect(out).toContain("Yes. The Stock Token factory records this contract as NVDA.");
    expect(out).toContain(`uid                 ${NVDA.uid}`);
    expect(out).toContain("What its price is");
    expect(out).toMatch(/^ {2}per token {11}\d[\d,]*\.\d{2} USD$/m);
    expect(out).toContain("The price of one token: the underlying share's 24/5 market price × the multiplier (1.000775159164630595).");
    expect(out).toMatch(/^ {2}multiplier {10}1\.000775$/m);
    expect(out).toMatch(/^ {2}transfers {11}open$/m);
    expect(out).toMatch(/^ {2}oracle pause {8}not paused$/m);
    expect(out).toContain("US equity session");
    expect(out).toContain("Multiplier changes   Hyvo's scan up to block");
    expect(out).toContain("1 → 1.000775159164630595 (× 1.000775)");
    expect(out).toContain("not a quote to trade at and not a forecast");
    expect(out).toContain("Read in 0.0 s: 1 request to reference-data-directory.vercel.app and 6 to rpc.test. Nothing was signed or sent.");
    expect(out.trimEnd().split("\n").at(-1)).toBe(`  Measured on-chain at block ${block}. Not a trading signal.`);
    expect(requests.map((r) => new URL(r.url).host).sort()).toEqual([...Array(6).fill("rpc.test"), "reference-data-directory.vercel.app"].sort());
    expect(hasBannedWords(out)).toBe(false);
  });

  it("prints the report as JSON, every bigint as a decimal string", async () => {
    const { route, block } = replay("rpc-nvda.json");
    const { code, out } = await stocks([NVDA.address, "--rpc", RPC, "--json"], [route, directory]);
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json).toMatchObject({ chainId: 4663, ticker: null, address: NVDA.address, block, verdict: { kind: "registered", uid: NVDA.uid } });
    expect(json.reading.blockNumber).toBe(block);
    expect(json.reading.token.totalSupply).toMatch(/^\d+$/);
    expect(json.multiplier).toMatchObject({ raw: "1000775159164630595", value: "1.000775159164630595", scheduled: null });
    expect(json.feed.kind).toBe("read");
    expect(json.feed.reading.answer).toMatch(/^\d+$/);
    expect(json.feed.price.perToken).toMatch(/^\d+\.\d+$/);
    expect(json.movement).toEqual({ transfers: "open", tokenPaused: false, registryPaused: false, oracle: "publishing" });
    expect(json.session.session).toMatch(/^(pre-market|regular|post-market|overnight|weekend)$/);
    expect(json.listed.address).toBe(NVDA.address);
    expect(json.disclaimer).toBe(`Measured on-chain at block ${block}. Not a trading signal.`);
  });

  it("says what a contract that is not a stock token is, and an address with no code", async () => {
    const factory = replay("rpc-factory.json");
    const notToken = await stocks([SNAPSHOT.factory, "--rpc", RPC], [factory.route, directory]);
    expect(notToken.code).toBe(0);
    expect(notToken.out).toContain("Is this a Robinhood stock token?");
    expect(notToken.out).toContain("No. This contract does not answer like a stock token.");
    expect(notToken.out).toContain("It is not a judgment of what the contract does.");
    expect(notToken.out).not.toContain("What its price is");
    expect(notToken.out.trimEnd().split("\n").at(-1)).toBe(`  Measured on-chain at block ${factory.block}. Not a trading signal.`);

    const empty = replay("rpc-empty.json");
    const nothing = await stocks(["0x000000000000000000000000000000000000dEaD", "--rpc", RPC, "--json"], [empty.route, directory]);
    expect(nothing.code).toBe(0);
    expect(JSON.parse(nothing.out).verdict).toEqual({ kind: "no-code" });
  });

  it("answers a ticker the list does not hold with exit 2 and what it holds instead", async () => {
    const unknown = await stocks(["APPL"], []);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("no stock token in Hyvo's list has the ticker APPL");
    expect(unknown.requests).toEqual([]);
    const json = await stocks(["APPLE", "--json"], []);
    expect(JSON.parse(json.out).error).toMatchObject({ code: "unknown_ticker" });
    expect(JSON.parse(json.out).error.message).toContain("AAPL (Apple)");
  });

  it("refuses what is neither a ticker nor an address", async () => {
    for (const argv of [["0x12"], ["NV DA"], ["NVDA", "--search", "x"], ["NVDA", "AAPL"]]) {
      const result = await stocks(argv, []);
      expect(result.code, argv.join(" ")).toBe(64);
      expect(result.requests).toEqual([]);
    }
  });

  it("reports a chain that refuses the token's reads with exit 2, not as a contract that is no stock token", async () => {
    const { route } = replay("rpc-nvda.json");
    // Every eth_call is answered HTTP 429, as a busy public endpoint answers; everything else as recorded.
    const busy: Route = (url, body) =>
      url.origin === RPC && body && (JSON.parse(body) as { method: string }).method === "eth_call" ? { status: 429, body: { error: "too many requests" } } : undefined;
    for (const argv of [["NVDA", "--rpc", RPC], ["NVDA", "--rpc", RPC, "--json"]]) {
      const { code, out, err } = await stocks(argv, [busy, route, directory]);
      expect(code, argv.join(" ")).toBe(2);
      expect(out + err).not.toContain("not a stock token");
      expect(out + err).not.toContain("not-a-stock-token");
      if (argv.includes("--json")) expect(JSON.parse(out).error.code).toBe("chain_unavailable");
      else expect(err).toMatch(/^hyvo: the token could not be read: /);
    }
  });

  it("reports a chain that does not answer with exit 2", async () => {
    const { code, err } = await stocks(["NVDA", "--rpc", RPC], [directory]);
    expect(code).toBe(2);
    expect(err).toMatch(/^hyvo: the token could not be read: /);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("hyvo stocks", () => {
  it("lists every token in Hyvo's scan, A to Z, and reads the factory's nonce live", async () => {
    const { code, out } = await stocks(["--rpc", RPC], [nonceRoute(SNAPSHOT.factoryNonce)]);
    expect(code).toBe(0);
    expect(out).toContain("HYVO STOCKS   Robinhood stock tokens");
    expect(out).toContain(`${SNAPSHOT.tokens.length} stock tokens: every token the StockFactory deployed up to block ${SNAPSHOT.block}, A to Z.`);
    expect(out).toContain("Read live at block 110015827: the factory has deployed nothing since.");
    expect(out).toMatch(/^ {2}ticker +contract +multiplier changes +name$/m);
    expect(out).toMatch(new RegExp(`^ {2}NVDA +${NVDA.address} +1 +NVIDIA$`, "m"));
    const tickers = [...out.matchAll(/^ {2}([A-Z][A-Z0-9._-]*) +0x[0-9a-fA-F]{40} /gm)].map((m) => m[1]!);
    expect(tickers).toHaveLength(SNAPSHOT.tokens.length);
    expect(tickers).toEqual([...tickers].sort((a, b) => a.localeCompare(b)));
    expect(out.trimEnd().split("\n").at(-1)).toBe(`  Measured on-chain at block ${SNAPSHOT.block}. Not a trading signal.`);
  });

  it("says when the factory has deployed more since the scan, and still lists when the chain does not answer", async () => {
    const more = await stocks(["--rpc", RPC], [nonceRoute(SNAPSHOT.factoryNonce + 2)]);
    expect(more.out).toContain("the factory has deployed 2 more tokens since. Look them up by address.");
    const offline = await stocks(["--rpc", RPC], []);
    expect(offline.code).toBe(0);
    expect(offline.out).toContain("The chain could not be read to check for newer tokens");
    expect(offline.out).toContain("NVDA");
  });

  it("filters with --search and prints JSON", async () => {
    const search = await stocks(["--search", "nvidia", "--rpc", RPC], [nonceRoute(SNAPSHOT.factoryNonce)]);
    expect(search.out).toContain('1 of the 212 stock tokens has a ticker or name that contains "nvidia".');
    const json = JSON.parse((await stocks(["--json", "--rpc", RPC], [nonceRoute(SNAPSHOT.factoryNonce)])).out);
    expect(json.snapshot).toEqual({ block: SNAPSHOT.block, time: SNAPSHOT.time, factoryNonce: SNAPSHOT.factoryNonce, tokens: SNAPSHOT.tokens.length });
    expect(json.live).toEqual({ block: "110015827", factoryNonce: SNAPSHOT.factoryNonce, deployedSince: 0 });
    expect(json.tokens).toHaveLength(SNAPSHOT.tokens.length);
    expect(json.tokens.find((token: { symbol: string }) => token.symbol === "NVDA")).toMatchObject({ address: NVDA.address, uid: NVDA.uid, multiplierChanges: 1 });
    expect(json.disclaimer).toBe(`Measured on-chain at block ${SNAPSHOT.block}. Not a trading signal.`);
  });
});
