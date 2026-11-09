// checkToken end to end against the fake Robinhood Chain in fake-chain.ts. No network.
import { describe, expect, it } from "vitest";
import { CheckError, checkToken, serializeReport } from "../src/index";
import { ADDRESSES } from "../src/registry/addresses";
import { OPTIONS, OWNER, PAIR, PLAIN_RESULT, TOKEN, fakeChain } from "./fake-chain";

describe("checkToken", () => {
  it("returns one report with every finding, the exit simulation and timings", async () => {
    const { fetch, calls } = fakeChain();
    const report = await checkToken(TOKEN.toLowerCase(), { ...OPTIONS, fetch });

    expect(report.chainId).toBe(4663);
    expect(report.block).toBe(254n);
    expect(report.token).toEqual({ address: TOKEN, name: "Test Token", symbol: "TT", decimals: 18, totalSupply: 10n ** 27n });
    const status = Object.fromEntries(report.findings.map((f) => [f.id, f.status]));
    expect(status).toEqual({
      source: "found",
      owner: "found",
      proxy: "not_found",
      mint: "found",
      "fee-setter": "not_found",
      blocklist: "not_found",
      pause: "not_found",
      venue: "found",
      "sell-simulation": "not_found",
      holders: "skipped",
      deployer: "found",
    });
    // A verified ABI is authoritative over the bytecode.
    expect(report.findings.find((f) => f.id === "mint")!.evidence).toContain("mint(address,uint256) (0x40c10f19) in the verified ABI (Sourcify)");
    expect(report.exit?.venue).toEqual({ kind: "v2", router: ADDRESSES.uniswapV2Router02.address, pair: PAIR });
    expect(report.exit?.sell?.ok).toBe(true);
    expect(report.exit?.roundTrip?.spent).toBe((10n ** 15n * PLAIN_RESULT.sellIn) / PLAIN_RESULT.gotBuy);
    expect(report.code).toEqual({ bytes: 12, proxyImplementation: null, owner: OWNER, ownerRenounced: false, sourcify: "full" });
    expect(report.notice).toContain("Not a trading signal");
    expect(report.timings.requests).toEqual({ rpc: calls.filter((c) => c.url === "https://rpc.test").length, sourcify: 1, blockscout: 0 });
    expect(report.timings.requests.rpc).toBeLessThanOrEqual(10);
    expect(report.timings.simulationMs).not.toBeNull();

    const json = JSON.parse(JSON.stringify(serializeReport(report)));
    expect(json.block).toBe("254");
    expect(json.exit.buy.arrived).toBe(PLAIN_RESULT.gotBuy.toString());
  });

  it("finds the tax when the probe reports shortfalls", async () => {
    const taxed = { ...PLAIN_RESULT, gotBuy: (PLAIN_RESULT.expectedBuy * 95n) / 100n, gotSell: (PLAIN_RESULT.expectedSell * 95n) / 100n };
    const { fetch } = fakeChain({ probeResult: taxed });
    const report = await checkToken(TOKEN, { ...OPTIONS, fetch });
    const f = report.findings.find((x) => x.id === "sell-simulation")!;
    expect(f.status).toBe("found");
    expect(f.evidence).toContain("5% short of the router's quote");
  });

  it("says so when the RPC ignores state overrides", async () => {
    const { fetch } = fakeChain({ probeResult: "empty" });
    const report = await checkToken(TOKEN, { ...OPTIONS, fetch });
    expect(report.exit).toBeNull();
    expect(report.findings.find((x) => x.id === "sell-simulation")).toMatchObject({
      status: "skipped",
      evidence: "the RPC does not honor state overrides in eth_call, which the simulation needs",
    });
  });

  it("falls back to the next RPC when one is down", async () => {
    const { fetch, calls } = fakeChain();
    const report = await checkToken(TOKEN, { ...OPTIONS, rpcUrls: ["https://down.test", "https://rpc.test"], fetch });
    expect(report.block).toBe(254n);
    expect(calls.some((c) => c.url === "https://down.test")).toBe(true);
  });

  it("treats Sourcify being down as a skipped source, not a failure", async () => {
    const { fetch } = fakeChain({ sourcify: { status: 502, body: {} } });
    const report = await checkToken(TOKEN, { ...OPTIONS, fetch });
    expect(report.findings.find((x) => x.id === "source")?.status).toBe("skipped");
    expect(report.code.sourcify).toBe("unknown");
    expect(report.findings.find((x) => x.id === "mint")?.evidence).toContain("bytecode's dispatcher");
  });

  it("throws a CheckError when no report can be made", async () => {
    await expect(checkToken("0x1234", { ...OPTIONS, fetch: fakeChain().fetch })).rejects.toMatchObject({ code: "invalid_address" });
    await expect(checkToken(TOKEN, { ...OPTIONS, fetch: fakeChain({ chainId: "0x1" }).fetch })).rejects.toMatchObject({ code: "wrong_chain" });
    await expect(checkToken(TOKEN, { ...OPTIONS, fetch: fakeChain({ code: "0x" }).fetch })).rejects.toMatchObject({ code: "not_a_contract" });
    await expect(
      checkToken(TOKEN, { ...OPTIONS, fetch: fakeChain({ view: (t) => (t.toLowerCase() === TOKEN.toLowerCase() ? null : undefined) }).fetch }),
    ).rejects.toMatchObject({ code: "not_a_token" });
    await expect(checkToken(TOKEN, { ...OPTIONS, rpcUrls: ["https://down.test"], fetch: fakeChain().fetch })).rejects.toMatchObject({ code: "rpc" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(checkToken(TOKEN, { ...OPTIONS, fetch: fakeChain().fetch, signal: aborted.signal })).rejects.toBeInstanceOf(CheckError);
    await expect(checkToken(TOKEN, { ...OPTIONS, fetch: fakeChain().fetch, signal: aborted.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});
