import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { decodeRevert } from "../src/chain/revert";
import { buildExit, sellSimulationFinding } from "../src/checks/sell-simulation";
import type { ProbeResult } from "../src/probe/index";
import type { Venue } from "../src/types";

const V2: Venue = { kind: "v2", router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba", pair: "0xdb661EC4D1ba1D9ad9D2A6Cd92FcE25a8F08aD25" };
const ETH_IN = 10n ** 15n;
const errorString = (s: string): `0x${string}` => `0x08c379a0${encodeAbiParameters(parseAbiParameters("string"), [s]).slice(2)}`;

function result(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    buyOk: true,
    expectedBuy: 1_000_000n,
    gotBuy: 1_000_000n,
    buyGas: 140_000n,
    buyErr: "0x",
    transferOk: true,
    transferSent: 100_000n,
    transferArrived: 100_000n,
    transferErr: "0x",
    approveOk: true,
    sellIn: 900_000n,
    expectedSell: 894_000_000_000_000n,
    sellOk: true,
    gotSell: 894_000_000_000_000n,
    sellGas: 75_000n,
    sellErr: "0x",
    ...over,
  };
}

describe("buildExit", () => {
  it("turns a plain round trip into steps and a round-trip cost", () => {
    const exit = buildExit(V2, ETH_IN, result());
    expect(exit.payout).toBe("eth");
    expect(exit.buy).toEqual({ ok: true, promised: 1_000_000n, arrived: 1_000_000n, shortfallPct: 0, gas: 140_000n, reason: null });
    expect(exit.transfer?.gas).toBeNull();
    expect(exit.roundTrip).toEqual({ spent: 900_000_000_000_000n, back: 894_000_000_000_000n, lossPct: 0.6666 });
  });

  it("stops after a buy that delivered nothing", () => {
    const exit = buildExit(V2, ETH_IN, result({ buyOk: false, gotBuy: 0n, expectedBuy: 0n, buyErr: errorString("no pair") }));
    expect(exit.buy.promised).toBeNull();
    expect(exit.buy.reason).toBe('Error("no pair")');
    expect(exit.transfer).toBeNull();
    expect(exit.sell).toBeNull();
    expect(exit.roundTrip).toBeNull();
  });

  it("pays out WETH on V3", () => {
    const v3: Venue = { kind: "v3", router: V2.router, quoter: V2.router, pool: V2.pair, fee: 10000 };
    expect(buildExit(v3, ETH_IN, result()).payout).toBe("weth");
  });
});

describe("the sell simulation finding", () => {
  it("is not found when every step arrives as promised", () => {
    const f = sellSimulationFinding(buildExit(V2, ETH_IN, result()), 18, 109_000_000n, null);
    expect(f.status).toBe("not_found");
    expect(f.evidence).toContain("at block 109,000,000 through the Uniswap V2 pair 0xdb66…aD25");
    expect(f.evidence).toContain("matching the router's quote");
    expect(f.evidence).toContain("(in full)");
    expect(f.evidence).toContain("the round trip lost 0.67%");
  });

  it("is found when a tax takes part of each step", () => {
    const taxed = result({ gotBuy: 950_000n, transferSent: 95_000n, transferArrived: 90_250n, sellIn: 855_000n, gotSell: 800_000_000_000_000n });
    const f = sellSimulationFinding(buildExit(V2, ETH_IN, taxed), 18, 1n, null);
    expect(f.status).toBe("found");
    expect(f.evidence).toContain("5% short of the router's quote");
    expect(f.evidence).toContain("(5% short)");
  });

  it("is found with the decoded reason when the sell reverts", () => {
    const blocked = result({ sellOk: false, gotSell: 0n, sellErr: errorString("TransferHelper: TRANSFER_FROM_FAILED") });
    const f = sellSimulationFinding(buildExit(V2, ETH_IN, blocked), 18, 1n, null);
    expect(f.status).toBe("found");
    expect(f.evidence).toContain('the sell reverted with Error("TransferHelper: TRANSFER_FROM_FAILED")');
  });

  it("is skipped when the buy reverts, or when there is no simulation", () => {
    const failed = buildExit(V2, ETH_IN, result({ buyOk: false, gotBuy: 0n, buyErr: "0x" }));
    const f = sellSimulationFinding(failed, 18, 1n, null);
    expect(f.status).toBe("skipped");
    expect(f.evidence).toContain("reverted with no reason given, so nothing was bought");
    expect(sellSimulationFinding(null, 18, 1n, "V4 pools outside Pons are not covered by the exit simulation yet").status).toBe("skipped");
  });

  it("never lets a contract's revert message put a banned word into the report", () => {
    const loud = result({ sellOk: false, gotSell: 0n, sellErr: errorString("this is a honeypot lol") });
    const f = sellSimulationFinding(buildExit(V2, ETH_IN, loud), 18, 1n, null);
    expect(f.evidence).toContain('Error("this is a […] lol")');
  });
});

describe("decodeRevert", () => {
  it("reads Error(string), Panic(uint256), known custom errors and V4's WrappedError", () => {
    expect(decodeRevert("0x")).toBe("no reason given");
    expect(decodeRevert(errorString("STF"))).toBe('Error("STF")');
    expect(decodeRevert(`0x4e487b71${(0x11).toString(16).padStart(64, "0")}`)).toBe("Panic(0x11: arithmetic overflow or underflow)");
    expect(decodeRevert(toFunctionSelector("CurrencyNotSettled()"))).toBe("CurrencyNotSettled()");
    const wrapped = `${toFunctionSelector("WrappedError(address,bytes4,bytes,bytes)")}${encodeAbiParameters(parseAbiParameters("address, bytes4, bytes, bytes"), [
      "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
      "0x575e24b4",
      errorString("hook says no"),
      "0x",
    ]).slice(2)}`;
    expect(decodeRevert(wrapped)).toBe('WrappedError(0xE5e7…e044, 0x575e24b4: Error("hook says no"))');
    expect(decodeRevert("0xdeadbeef")).toBe("custom error 0xdeadbeef");
  });
});
