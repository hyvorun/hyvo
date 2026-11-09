import { CHECK_NOTICE, CheckError, type CheckReport, type ExitSimulation, type Finding, type Step, type TokenInfo } from "@hyvo/check";
import { describe, expect, it } from "vitest";
import {
  checkFailure,
  difference,
  exitState,
  exitSteps,
  findingSummary,
  parseAddressInput,
  roundTripView,
  sentence,
  shares,
  tokenAmount,
  venueView,
} from "../src/lib/check-view";

const TOKEN = "0x8EEe67a8aaD993F15b4506975b38c52f6D3ce758";
const PAIR = "0xDB661ec4D1BA1D9Ad9D2a6CD92FCe25a8F08AD25";
const E18 = 10n ** 18n;

const token: TokenInfo = { address: TOKEN, name: "Test Token", symbol: "TT", decimals: 18, totalSupply: 10n ** 27n };

function step(over: Partial<Step> = {}): Step {
  return { ok: true, promised: 1000n * E18, arrived: 1000n * E18, shortfallPct: 0, gas: 100_000n, reason: null, ...over };
}

function exit(over: Partial<ExitSimulation> = {}): ExitSimulation {
  return {
    venue: { kind: "v2", router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba", pair: PAIR },
    ethIn: 10n ** 15n,
    payout: "eth",
    buy: step(),
    transfer: step({ promised: 100n * E18, arrived: 100n * E18, gas: null }),
    sell: step({ promised: 894_000_000_000_000n, arrived: 894_000_000_000_000n, gas: 70_000n }),
    roundTrip: { spent: 900_000_000_000_000n, back: 894_000_000_000_000n, lossPct: 0.6667 },
    ...over,
  };
}

function finding(id: Finding["id"], status: Finding["status"], evidence: string): Finding {
  return { id, title: id, status, evidence };
}

function report(over: Partial<CheckReport> = {}): CheckReport {
  return {
    chainId: 4663,
    token,
    block: 109_871_825n,
    findings: [finding("venue", "found", "the Uniswap V2 pair 0xDB66…AD25 with WETH"), finding("sell-simulation", "not_found", "at block 109,871,825 …")],
    exit: exit(),
    code: { bytes: 4000, proxyImplementation: null, owner: null, ownerRenounced: false, sourcify: "none" },
    timings: { totalMs: 1500, chainMs: 1000, simulationMs: 300, sourcesMs: 900, requests: { rpc: 9, sourcify: 1, blockscout: 0 } },
    notice: CHECK_NOTICE,
    ...over,
  };
}

describe("parseAddressInput", () => {
  it("takes an address in any case and gives it back checksummed", () => {
    expect(parseAddressInput("0x8eee67a8aad993f15b4506975b38c52f6d3ce758")).toBe(TOKEN);
    expect(parseAddressInput("  0X8EEE67A8AAD993F15B4506975B38C52F6D3CE758 \n")).toBe(TOKEN);
  });

  it("finds the address in a pasted link", () => {
    expect(parseAddressInput("https://robinhoodchain.blockscout.com/token/0x8eee67a8aad993f15b4506975b38c52f6d3ce758?tab=holders")).toBe(TOKEN);
    expect(parseAddressInput("https://hyvo.run/check/0x8eee67a8aad993f15b4506975b38c52f6d3ce758")).toBe(TOKEN);
  });

  it("refuses what is not an address, a transaction hash included", () => {
    expect(parseAddressInput(`0x${"ab".repeat(32)}`)).toBeNull();
    expect(parseAddressInput(`https://robinhoodchain.blockscout.com/tx/0x${"ab".repeat(32)}`)).toBeNull();
    expect(parseAddressInput("0x1234")).toBeNull();
    expect(parseAddressInput("")).toBeNull();
    expect(parseAddressInput("KSTX")).toBeNull();
  });
});

describe("sentence", () => {
  it("starts evidence with a capital and ends it with a full stop", () => {
    expect(sentence("neither owner() nor getOwner() answers")).toBe("Neither owner() nor getOwner() answers.");
    expect(sentence("V4 pools outside Pons are not covered by the exit simulation yet")).toBe(
      "V4 pools outside Pons are not covered by the exit simulation yet.",
    );
  });

  it("leaves a leading function name or address as the chain spells it", () => {
    expect(sentence("owner() returns 0xcFA0…4C6F")).toBe("owner() returns 0xcFA0…4C6F.");
    expect(sentence("mint(address,uint256) (0x40c10f19) in the verified ABI")).toBe("mint(address,uint256) (0x40c10f19) in the verified ABI.");
    expect(sentence("increaseSupply(uint256) (0xb921e163)")).toBe("increaseSupply(uint256) (0xb921e163).");
    expect(sentence("Already a sentence.")).toBe("Already a sentence.");
  });
});

describe("difference", () => {
  it("says how far what arrived is from the promise, with a sign", () => {
    expect(difference(5, "promised")).toEqual({ text: "−5%", note: "5% less than promised", tone: "lost" });
    expect(difference(3.8912, "promised")).toEqual({ text: "−3.89%", note: "3.89% less than promised", tone: "lost" });
    expect(difference(-0.2, "promised")).toEqual({ text: "+0.2%", note: "0.2% more than promised", tone: "more" });
    expect(difference(100, "sent")).toEqual({ text: "−100%", note: "100% less than sent", tone: "lost" });
  });

  it("reads nothing into rounding in the venue's own math", () => {
    expect(difference(0, "promised")).toEqual({ text: "0%", note: "as promised", tone: "even" });
    expect(difference(0, "sent")).toEqual({ text: "0%", note: "in full", tone: "even" });
    expect(difference(0.004, "promised")).toEqual({ text: "0%", note: "as promised", tone: "even" });
    expect(difference(0.008, "promised")).toEqual({ text: "−0.01%", note: "within rounding", tone: "even" });
  });
});

describe("shares", () => {
  it("splits a promise into what arrived and what did not", () => {
    expect(shares(100n, 95n)).toEqual({ arrived: 0.95, lost: 0.05 });
    expect(shares(3n, 1n)).toEqual({ arrived: 0.3333, lost: 0.6667 });
    expect(shares(100n, 120n)).toEqual({ arrived: 1, lost: 0 });
    expect(shares(0n, 5n)).toBeNull();
  });
});

describe("exitSteps", () => {
  it("shows a taxed token's three steps against their promises", () => {
    const taxed = exit({
      buy: step({ arrived: 950n * E18, shortfallPct: 5 }),
      transfer: step({ promised: 95n * E18, arrived: 90_250_000_000_000_000_000n, shortfallPct: 5, gas: null }),
      sell: step({ promised: 800_000_000_000_000n, arrived: 760_000_000_000_000n, shortfallPct: 5 }),
    });
    const [buy, transfer, sell] = exitSteps(taxed, token);
    expect(buy).toMatchObject({
      number: 1,
      title: "Buy",
      line: "0.001 ETH in",
      state: "done",
      promisedLabel: "Promised",
      promised: "1,000 TT",
      arrived: "950 TT",
      difference: { text: "−5%", tone: "lost" },
      bar: { arrived: 0.95, lost: 0.05 },
      gas: "100,000",
    });
    expect(transfer).toMatchObject({ title: "Send to another wallet", promisedLabel: "Sent", promised: "95 TT", arrived: "90.25 TT", gas: null });
    expect(transfer?.difference?.note).toBe("5% less than sent");
    expect(sell).toMatchObject({ title: "Sell back", line: "The rest, back to ETH", promised: "0.0008 ETH", arrived: "0.00076 ETH" });
  });

  it("quotes a revert and leaves out a difference that would read as a loss", () => {
    const blocked = exit({
      sell: step({ ok: false, promised: 894_000_000_000_000n, arrived: 0n, shortfallPct: 100, reason: 'Error("TransferHelper: TRANSFER_FROM_FAILED")' }),
      roundTrip: null,
    });
    const sell = exitSteps(blocked, token)[2]!;
    expect(sell).toMatchObject({
      state: "reverted",
      promised: "0.000894 ETH",
      arrived: "0 ETH",
      difference: null,
      bar: null,
      reason: 'Error("TransferHelper: TRANSFER_FROM_FAILED")',
    });
  });

  it("marks the transfer and the sell as not tried when the buy reverted", () => {
    const reverted = exit({ buy: step({ ok: false, arrived: 0n, reason: "no reason given" }), transfer: null, sell: null, roundTrip: null });
    const [buy, transfer, sell] = exitSteps(reverted, { ...token, symbol: null });
    expect(buy).toMatchObject({ state: "reverted", arrived: "0 tokens", reason: "no reason given" });
    expect(transfer).toMatchObject({ state: "not_tried", reason: "Not tried: the buy reverted, so there was nothing to send or sell." });
    expect(sell?.state).toBe("not_tried");
  });

  it("pays out in WETH where the venue does", () => {
    expect(exitSteps(exit({ payout: "weth" }), token)[2]).toMatchObject({ line: "The rest, back to WETH", arrived: "0.000894 WETH" });
  });
});

describe("roundTripView", () => {
  it("states the cost of buying and selling straight back", () => {
    expect(roundTripView(exit())).toEqual({
      kind: "cost",
      percent: "0.67%",
      line: "The part that was sold cost 0.0009 ETH at the buy's average price, and 0.000894 ETH came back.",
      bar: { arrived: 0.9933, lost: 0.0067 },
    });
  });

  it("says when more came back than went in", () => {
    const gain = roundTripView(exit({ roundTrip: { spent: 900n, back: 909n, lossPct: -1 } }));
    expect(gain).toMatchObject({ kind: "gain", percent: "1%", bar: { arrived: 1, lost: 0 } });
  });

  it("says why there is no round trip", () => {
    expect(roundTripView(exit({ sell: step({ ok: false, arrived: 0n }), roundTrip: null })).line).toBe("No round trip: the sell did not go through.");
    expect(roundTripView(exit({ buy: step({ ok: false }), transfer: null, sell: null, roundTrip: null })).line).toBe(
      "No round trip: the buy did not go through.",
    );
  });
});

describe("venueView", () => {
  it("names each venue with its own facts", () => {
    expect(venueView({ kind: "v2", router: TOKEN, pair: PAIR })).toMatchObject({ name: "Uniswap V2 pair with WETH", address: PAIR, facts: [] });
    expect(venueView({ kind: "v3", router: TOKEN, quoter: TOKEN, pool: PAIR, fee: 10_000 }).facts).toEqual([{ label: "Fee tier", value: "1%" }]);
    expect(
      venueView({ kind: "pons-curve", curve: PAIR, curveFeeBps: 100, creatorTaxBps: 289, snipeTaxBpsNow: null }).facts.map((fact) => fact.value),
    ).toEqual(["1%", "2.89%", "unknown"]);
    const v4 = venueView({
      kind: "pons-v4",
      poolManager: TOKEN,
      hooks: PAIR,
      fee: 0x800000,
      tickSpacing: 200,
      creatorTaxBps: 0,
      quote: "0x0000000000000000000000000000000000000000",
    });
    expect(v4.facts).toEqual([
      { label: "Pool fee", value: "set by the hook" },
      { label: "Creator tax", value: "0%" },
      { label: "Tick spacing", value: "200" },
      { label: "Quoted in", value: "ETH" },
    ]);
    expect(v4.promises).toBe("the pool's swap delta inside each trade");
  });
});

describe("exitState", () => {
  it("tells a missing venue from one the simulation cannot reach, and from a simulation that failed", () => {
    expect(exitState(report()).kind).toBe("simulated");

    const none = report({
      exit: null,
      timings: { ...report().timings, simulationMs: null },
      findings: [finding("venue", "not_found", "no Pons v2 launch record, …"), finding("sell-simulation", "skipped", "no venue was found")],
    });
    expect(exitState(none)).toEqual({ kind: "no_venue", reason: "no venue was found", venueEvidence: "no Pons v2 launch record, …" });

    const uncovered = report({
      exit: null,
      timings: { ...report().timings, simulationMs: null },
      findings: [
        finding("venue", "found", "the Uniswap V4 PoolManager 0x8366…0951 holds 2,075.4 tokens"),
        finding("sell-simulation", "skipped", "V4 pools outside Pons are not covered by the exit simulation yet"),
      ],
    });
    expect(exitState(uncovered).kind).toBe("not_covered");

    const failed = report({
      exit: null,
      findings: [finding("venue", "found", "the Uniswap V2 pair …"), finding("sell-simulation", "skipped", "the RPC does not honor state overrides")],
    });
    expect(exitState(failed)).toMatchObject({ kind: "failed", reason: "the RPC does not honor state overrides" });
  });
});

describe("findingSummary and tokenAmount", () => {
  it("counts the findings by status", () => {
    expect(
      findingSummary([finding("owner", "found", "x"), finding("proxy", "not_found", "x"), finding("mint", "not_found", "x"), finding("holders", "skipped", "x")]),
    ).toBe("4 checks: 1 found, 2 not found, 1 skipped");
  });

  it("writes token amounts with the token's decimals and symbol", () => {
    expect(tokenAmount(1_500_000n, { ...token, decimals: 6, symbol: "USDG" })).toBe("1.5 USDG");
    expect(tokenAmount(581_054_078_393_318_008_147_934n, token)).toBe("581,054.07 TT");
  });
});

describe("checkFailure", () => {
  it("explains why no report could be made, and whether trying again can help", () => {
    expect(checkFailure(new CheckError("not_a_contract", "x"))).toMatchObject({ title: "No contract at this address", retry: false });
    expect(checkFailure(new CheckError("not_a_token", "x"))).toMatchObject({ title: "Not a token", retry: false });
    expect(checkFailure(new CheckError("rpc", "x"))).toMatchObject({ title: "Robinhood Chain could not be read just now", retry: true });
    expect(checkFailure(new CheckError("wrong_chain", "the RPC answers for chain 1, not Robinhood Chain (4663)")).detail).toBe(
      "The RPC answers for chain 1, not Robinhood Chain (4663). Nothing was checked.",
    );
    expect(checkFailure(new Error("boom"))).toEqual({ title: "The check could not finish", detail: "Boom.", retry: true });
  });
});
