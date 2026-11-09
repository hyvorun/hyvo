// A fake terminal, network and clock for running commands in-process, and a report as Hyvo Check makes one.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckReport, checkToken } from "@hyvo/check";
import { makePalette } from "../src/color";
import type { Context } from "../src/context";
import { main } from "../src/cli";

export interface Captured {
  ctx: Context;
  stdout(): string;
  stderr(): string;
  /** Every request the command made, in order. */
  requests: { url: string; method: string; body: string | undefined }[];
}

export type Route = (url: URL, body: string | undefined) => { status?: number; body: unknown; headers?: Record<string, string> } | undefined;

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hyvo-cli-test-"));
}

export function testContext(overrides: Partial<Context> & { routes?: Route[]; stdin?: string[] } = {}): Captured {
  let out = "";
  let err = "";
  const requests: Captured["requests"] = [];
  const routes = overrides.routes ?? [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url: url.href, method: init?.method ?? "GET", body });
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    for (const route of routes) {
      const answer = route(url, body);
      if (answer) {
        const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
        return new Response(text, { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
      }
    }
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  }) as typeof fetch;
  const interrupt = new AbortController();
  const ctx: Context = {
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    env: {},
    palette: makePalette(false),
    columns: null,
    fetch: fakeFetch,
    now: () => Date.UTC(2026, 10, 9, 7, 0, 0),
    sleep: async () => {},
    configDir: tempDir(),
    interrupt: () => interrupt.signal,
    stdinLines: async function* () {
      for (const line of overrides.stdin ?? []) yield line;
    },
    checkToken: (async () => {
      throw new Error("checkToken was not stubbed");
    }) as typeof checkToken,
    ...overrides,
  };
  return { ctx, stdout: () => out, stderr: () => err, requests };
}

export async function run(argv: string[], captured: Captured): Promise<number> {
  return main(argv, captured.ctx);
}

/** A checksummed address with one letter's case turned, as a mistyped character would leave it. */
export function mistype(address: string): string {
  const at = address.slice(2).search(/[a-fA-F]/) + 2;
  const letter = address[at]!;
  return address.slice(0, at) + (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()) + address.slice(at + 1);
}

export const TOKEN = "0x8EEe67a8aaD993F15b4506975b38c52f6D3ce758";
export const OWNER = "0x6C1A66A1E887c3C0D0246557Dc6bC289F4365d2E";
export const PAIR = "0x1111111111111111111111111111111111111111";

/** A report shaped as `checkToken` returns it: a token trading in a Uniswap V2 pair, with an owner and a mint function. */
export function sampleReport(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    chainId: 4663,
    token: { address: TOKEN, name: "Sample Token", symbol: "SMPL", decimals: 18, totalSupply: 1_000_000n * 10n ** 18n },
    block: 107_512_345n,
    findings: [
      { id: "source", title: "Verified source", status: "found", evidence: "Sourcify holds an exact match for the token's code" },
      { id: "owner", title: "Owner address", status: "found", evidence: `owner() returns ${OWNER}` },
      { id: "proxy", title: "Proxy", status: "not_found", evidence: "no EIP-1967 implementation or beacon slot, and not an EIP-1167 clone" },
      { id: "mint", title: "Mint function", status: "found", evidence: "mint(address,uint256) 0x40c10f19 in the verified ABI; the owner is " + OWNER },
      { id: "fee-setter", title: "Fee or tax setter", status: "not_found", evidence: "none of setFee, setTaxes, setSellTax and 20 more in the verified ABI" },
      { id: "blocklist", title: "Address blocklist", status: "not_found", evidence: "none of blacklist, setBlocked, freeze(address) and 12 more in the verified ABI" },
      { id: "pause", title: "Pause or trading switch", status: "not_found", evidence: "none of pause, setTradingEnabled, enableTrading and 9 more in the verified ABI" },
      { id: "venue", title: "Trading venue", status: "found", evidence: `the Uniswap V2 pair ${PAIR} with WETH holds 12.5 WETH and 1,000,000 SMPL` },
      {
        id: "sell-simulation",
        title: "Sell or transfer shortfall",
        status: "not_found",
        evidence:
          "at block 107,512,345 through the Uniswap V2 pair 0x1111…1111: the buy of 0.001 ETH delivered 79.83 tokens, as the router's quote promised; sending 7.98 to a fresh address delivered 7.98 (in full); the sell brought back 0.000894 ETH, as the router's quote promised; the round trip lost 0.6% of what the sold part cost",
      },
      { id: "holders", title: "Top holders", status: "skipped", evidence: "needs a Blockscout API key (HYVO_BLOCKSCOUT_KEY); without one Blockscout is not asked" },
      { id: "deployer", title: "Deployer", status: "found", evidence: `${OWNER}, from Sourcify's deployment record` },
    ],
    exit: {
      venue: { kind: "v2", router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba", pair: PAIR },
      ethIn: 10n ** 15n,
      payout: "eth",
      buy: { ok: true, promised: 79_830_000_000_000_000_000n, arrived: 79_830_000_000_000_000_000n, shortfallPct: 0, gas: 133_547n, reason: null },
      transfer: { ok: true, promised: 7_983_000_000_000_000_000n, arrived: 7_983_000_000_000_000_000n, shortfallPct: 0, gas: null, reason: null },
      sell: { ok: true, promised: 894_000_000_000_000n, arrived: 894_000_000_000_000n, shortfallPct: 0, gas: 70_281n, reason: null },
      roundTrip: { spent: 900_000_000_000_000n, back: 894_600_000_000_000n, lossPct: 0.6 },
    },
    code: { bytes: 5321, proxyImplementation: null, owner: OWNER, ownerRenounced: false, sourcify: "full" },
    timings: { totalMs: 2412, chainMs: 1200, simulationMs: 300, sourcesMs: 900, requests: { rpc: 9, sourcify: 1, blockscout: 0 } },
    notice: "Facts read from Robinhood Chain at one block, each with its evidence. Not a trading signal, and not an audit.",
    ...overrides,
  };
}

const vectors = new URL("../../schema/test-vectors/", import.meta.url);

/** packages/schema's sample run: its exact bytes and what its hashes are. */
export const SAMPLE_RUN = {
  text: readFileSync(new URL("sample-run.json", vectors), "utf8"),
  meta: JSON.parse(readFileSync(new URL("sample-run.meta.json", vectors), "utf8")) as { hash: string; scenarioHash: string; runIdBytes32: string },
  summary: JSON.parse(readFileSync(new URL("sample-run.summary.json", vectors), "utf8")) as Record<string, unknown>,
  runId: "run_01M6E22WG0NQFVT4Q4295NMG1Z",
};
