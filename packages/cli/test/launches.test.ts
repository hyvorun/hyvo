import { CALL_ENDPOINTS, LOG_ENDPOINTS, NATIVE } from "@hyvo/launches";
import { DEMO_HEAD, DEMO_LAUNCHES, DEMO_PACE, DEMO_TIME, DEMO_V1, demoChain, FakeChain, fakeAddress } from "@hyvo/launches/testing";
import { describe, expect, it } from "vitest";
import { hasBannedWords } from "../../check/src/output/copy";
import { mistype, run, testContext, type Route } from "./helpers";

const RPC = "https://rpc.test";
const PUBLIC = [...CALL_ENDPOINTS, ...LOG_ENDPOINTS.map((option) => (typeof option === "string" ? option : option.url))].map((url) => new URL(url).origin);
const LAST_LINE = `  Measured on-chain at block ${DEMO_HEAD}. Not a trading signal.`;

/** Answers JSON-RPC at `origins` as the made-up Pons world of @hyvo/launches/testing would. */
function chainRoute(origins: string[] = [RPC], chain = demoChain()): Route {
  return (url, body) => (origins.includes(url.origin) && body ? { body: JSON.parse(chain.answerText(url.href, body)) } : undefined);
}

async function launches(argv: string[], routes: Route[] = [chainRoute()]) {
  const c = testContext({ routes });
  const code = await run(["launches", ...argv], c);
  return { code, out: c.stdout(), err: c.stderr(), requests: c.requests };
}

const fizz = DEMO_LAUNCHES[0]!;
const brisk = DEMO_LAUNCHES[5]!;

describe("hyvo launches", () => {
  it("lists the newest launches of the last 6 hours with their curves' state, and the disclaimer last", async () => {
    const { code, out, err, requests } = await launches(["--rpc", RPC]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("HYVO LAUNCHES   Pons V2, the last 6 hours");
    expect(out).toContain(`curves read at block ${DEMO_HEAD}`);
    expect(out).toContain("10 launches in the last 6 hours. Paired with: ETH 6, USDG 2,");
    expect(out).toMatch(/^ {2}age +token +pair +phase +on its curve +creator tax +address$/m);
    expect(out).toMatch(new RegExp(`^ {2}3 min +FIZZ +ETH +on its curve +0\\.05994 of 4\\.2 ETH, 1\\.4% +0% +${fizz.token}$`, "m"));
    expect(out).toMatch(new RegExp(`^ {2}1 h 10 min +BRISK +ETH +graduated +moved to its pool +10% +${brisk.token}$`, "m"));
    expect(out).toMatch(/^ {2}19 min +GLINT +USDG +on its curve +642\.9 of 8,090 USDG, 7\.9% +2% /m);
    expect(out).toContain("One launch's facts: hyvo launches <token>");
    expect(out).toContain("Nothing was signed or sent.");
    expect(out.trimEnd().split("\n").at(-1)).toBe(LAST_LINE);
    expect(new Set(requests.map((r) => new URL(r.url).origin))).toEqual(new Set([RPC]));
    expect(requests.every((r) => r.method === "POST")).toBe(true);
  });

  it("narrows the window with --hours and the rows with --limit", async () => {
    const hour = await launches(["--rpc", RPC, "--hours", "1"]);
    expect(hour.out).toContain("5 launches in the last hour. Paired with: ETH 2, USDG 2, NVDA 1.");
    expect(hour.out).not.toContain("BRISK");
    const three = await launches(["--rpc", RPC, "--limit", "3"]);
    expect(three.out).toContain("7 more in the window: hyvo launches --hours 6 --limit 10");
    expect(three.out).toContain("GLINT");
    expect(three.out).not.toContain("MOTE");
  });

  it("counts the curves that graduated in the window apart from the window's launches, and says when each launched", async () => {
    // BRISK launched 70 minutes ago and graduated about 35 minutes ago: inside the 6-hour window both times, and
    // inside the last hour only for its graduation, which is not one of that hour's five launches.
    const six = await launches(["--rpc", RPC]);
    expect(six.out).toContain("1 curve graduated to its pool in these blocks (it launched in the window).");
    const hour = await launches(["--rpc", RPC, "--hours", "1"]);
    expect(hour.out).not.toMatch(/5 launches in the last hour, 1 graduated/);
    expect(hour.out).toContain("1 curve graduated to its pool in these blocks (it launched before the window).");
    const json = JSON.parse((await launches(["--rpc", RPC, "--hours", "1", "--json"])).out);
    expect(json.graduations).toEqual([expect.objectContaining({ token: brisk.token, launchedInWindow: false })]);
  });

  it("says a curve moved to its pool only when the factory's PoolGraduated is in the window", async () => {
    // FIZZ's curve has been swept (graduated() is true), but the factory has not created its pool yet.
    const chain = demoChain();
    chain.launches[0] = { ...chain.launches[0]!, phase: 1 };
    const { out } = await launches(["--rpc", RPC], [chainRoute([RPC], chain)]);
    expect(out).toMatch(new RegExp(`^ {2}3 min +FIZZ +ETH +graduated +off its curve, no pool yet +0% +${fizz.token}$`, "m"));
    expect(out).toMatch(new RegExp(`^ {2}1 h 10 min +BRISK +ETH +graduated +moved to its pool +10% +${brisk.token}$`, "m"));
  });

  it("suggests a larger --limit only while one would list more, and a shorter window past the newest 100", async () => {
    // 105 launches in the last 6 hours, one a minute.
    const crowded = new FakeChain({
      head: DEMO_HEAD,
      headTime: DEMO_TIME,
      blocksPerSecond: DEMO_PACE,
      launches: Array.from({ length: 105 }, (_, i) => ({
        token: fakeAddress(`crowd:token:${i}`),
        curve: fakeAddress(`crowd:curve:${i}`),
        creator: fakeAddress(`crowd:creator:${i}`),
        pairToken: NATIVE,
        symbol: `C${i}`,
        name: `Crowd ${i}`,
        block: DEMO_HEAD - BigInt(Math.round((i + 1) * 60 * DEMO_PACE)),
        launchedAt: DEMO_TIME - (i + 1) * 60,
        graduationThreshold: 4_200_000_000_000_000_000n,
        liquidity: 10n ** 16n,
      })),
    });
    const route = [chainRoute([RPC], crowded)];
    const most = await launches(["--rpc", RPC, "--limit", "100"], route);
    expect(most.code).toBe(0);
    expect(most.out).not.toContain("--limit 100");
    expect(most.out).toContain("5 more in the window: at most the newest 100 are listed; a shorter window has fewer: hyvo launches --hours 1");
    const few = await launches(["--rpc", RPC, "--limit", "20"], route);
    expect(few.out).toContain("85 more in the window: hyvo launches --hours 6 --limit 100");
  });

  it("prints JSON with every amount and block as a decimal string", async () => {
    const { code, out } = await launches(["--rpc", RPC, "--json"]);
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(Object.keys(json)).toEqual(["chainId", "window", "block", "timestamp", "launches", "notListed", "graduations", "disclaimer"]);
    expect(json.window).toMatchObject({ hours: 6, toBlock: String(DEMO_HEAD), launches: 10, graduations: 1 });
    expect(json.block).toBe(String(DEMO_HEAD));
    expect(json.disclaimer).toBe(`Measured on-chain at block ${DEMO_HEAD}. Not a trading signal.`);
    const first = json.launches[0];
    expect(first).toMatchObject({
      token: fizz.token,
      symbol: "FIZZ",
      pair: { symbol: "ETH", decimals: 18 },
      graduated: false,
      creatorTaxBps: 0,
      liquidity: "59940000000000000",
      graduationThreshold: "4200000000000000000",
      progress: 0.0142,
    });
    expect(json.graduations[0]).toMatchObject({ token: brisk.token, pairTokenAmount: "4200000000000000000" });
    expect(typeof json.graduations[0].block).toBe("string");
  });

  it("reads one launch in full, with the last hour on its curve", async () => {
    const { code, out } = await launches([fizz.token, "--rpc", RPC]);
    expect(code).toBe(0);
    expect(out).toContain("HYVO LAUNCHES   FIZZ   ");
    expect(out).toContain(`Pons V2 launch · ${fizz.token} · block ${DEMO_HEAD}`);
    expect(out).toMatch(/^ {2}phase {15}On its curve$/m);
    expect(out).toContain("towards graduation  1.4%: its curve holds 0.05994 ETH of the 4.2 ETH it graduates at");
    expect(out).toContain("launch-second tax   99%, gone after 3 s");
    expect(out).toContain(`creator             ${fizz.creator}`);
    expect(out).toContain("The last hour on its curve   blocks");
    expect(out).toMatch(/^ {2}trades {14}27: 18 buys and 9 sells$/m);
    expect(out).toMatch(/^ {2}traders {13}15$/m);
    expect(out).toContain(`hyvo check ${fizz.token}`);
    expect(out.trimEnd().split("\n").at(-1)).toBe(LAST_LINE);

    const json = JSON.parse((await launches([fizz.token, "--rpc", RPC, "--json"])).out);
    expect(json).toMatchObject({ kind: "v2", token: fizz.token, phase: "curve", phaseText: "On its curve", liquidity: "59940000000000000", feeBps: 100, block: String(DEMO_HEAD) });
    expect(json.lastHour).toMatchObject({ trades: 27, buys: 18, sells: 9, traders: 15 });
    expect(typeof json.lastHour.volume).toBe("string");
    expect(json).not.toHaveProperty("read");
    expect(json.disclaimer).toBe(`Measured on-chain at block ${DEMO_HEAD}. Not a trading signal.`);
  });

  it("says what a Pons V1 token and an address without a Pons record are", async () => {
    const v1 = await launches([DEMO_V1.token, "--rpc", RPC]);
    expect(v1.code).toBe(0);
    expect(v1.out).toContain("Pons V1 launch");
    expect(v1.out).toContain("starts in a Uniswap V3 pool against WETH, at a 1% fee");
    expect(JSON.parse((await launches([DEMO_V1.token, "--rpc", RPC, "--json"])).out)).toMatchObject({ kind: "v1", symbol: "OLDIE", poolFee: 10000 });

    const stranger = fakeAddress("not a launch");
    const none = await launches([stranger, "--rpc", RPC]);
    expect(none.code).toBe(0);
    expect(none.out).toContain(`No Pons V2 launch at this address. The Pons V2 launch factory has no record of ${stranger}`);
    expect(none.out.trimEnd().split("\n").at(-1)).toBe(LAST_LINE);
  });

  it("reads through the public endpoints when no RPC is chosen", async () => {
    const { code, requests } = await launches([], [chainRoute(PUBLIC)]);
    expect(code).toBe(0);
    const hosts = new Set(requests.map((r) => new URL(r.url).host));
    expect([...hosts].every((host) => PUBLIC.some((origin) => origin.endsWith(host)))).toBe(true);
    expect(hosts.has("robinhood.drpc.org")).toBe(true);
  });

  it("answers an unreadable chain with exit 2, as JSON with --json", async () => {
    const down = await launches(["--rpc", RPC], []);
    expect(down.code).toBe(2);
    expect(down.err).toContain("hyvo: Robinhood Chain could not be read: no endpoint answered eth_getBlockByNumber");
    const json = await launches(["--rpc", RPC, "--json"], []);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).error.code).toBe("chain_unavailable");
  });

  it("reads an address typed in capitals or small letters, and refuses mixed case that fails its checksum", async () => {
    for (const typed of [`0x${fizz.token.slice(2).toUpperCase()}`, fizz.token.toLowerCase()]) {
      const { code, out, err } = await launches([typed, "--rpc", RPC]);
      expect(err, typed).toBe("");
      expect(code, typed).toBe(0);
      expect(out).toContain(`Pons V2 launch · ${fizz.token} · block ${DEMO_HEAD}`);
    }
    const stranger = fakeAddress("not a launch");
    const none = await launches([stranger.toLowerCase(), "--rpc", RPC]);
    expect(none.out).toContain(`The Pons V2 launch factory has no record of ${stranger}`);

    const mistyped = mistype(fizz.token);
    const refused = await launches([mistyped, "--rpc", RPC]);
    expect(refused.code).toBe(64);
    expect(refused.err).toContain("capital letters do not match its checksum");
    expect(refused.requests).toEqual([]);
  });

  it("refuses bad options before any request", async () => {
    for (const argv of [["--hours", "5"], ["--limit", "0"], ["--limit", "101"], ["0x12"], [fizz.token, "--limit", "3"], [fizz.token, fizz.token]]) {
      const result = await launches(argv);
      expect(result.code, argv.join(" ")).toBe(64);
      expect(result.requests).toEqual([]);
    }
  });

  it("uses no word Hyvo never uses about a token", async () => {
    const { out } = await launches(["--rpc", RPC]);
    const one = await launches([fizz.token, "--rpc", RPC]);
    expect(hasBannedWords(out + one.out)).toBe(false);
  });
});
