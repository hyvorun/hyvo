import { describe, expect, it } from "vitest";
import { HOLDER_RULE_UNSET, durationText, formatHyvo, holderRule, holderTermsFrom } from "../src/lib/holder";
import { ONLY_TOKEN, officialToken } from "../src/lib/official";

const HEALTH = {
  ok: true,
  version: "test",
  features: { payments: true, oracle: true, holder: true, clone: true },
  limits: { minAgents: 10, maxAgents: 500, minRounds: 3, maxRounds: 30, maxDecisions: 840 },
};

describe("holderTermsFrom", () => {
  it("reads the holder terms /v1/health states", () => {
    const holder = { min: "1000000", decimals: 18, heldForSeconds: 86_400 };
    expect(holderTermsFrom({ ...HEALTH, holder })).toEqual(holder);
  });

  it("gives null when the API sends none, sends null, or sends a minimum of zero", () => {
    expect(holderTermsFrom(HEALTH)).toBeNull();
    expect(holderTermsFrom({ ...HEALTH, holder: null })).toBeNull();
    expect(holderTermsFrom({ ...HEALTH, holder: { min: "0", decimals: 18, heldForSeconds: 86_400 } })).toBeNull();
    expect(holderTermsFrom({ ...HEALTH, holder: { min: "0.000", decimals: 18, heldForSeconds: 86_400 } })).toBeNull();
  });

  it("gives null for terms it cannot read", () => {
    expect(holderTermsFrom(null)).toBeNull();
    expect(holderTermsFrom("ok")).toBeNull();
    expect(holderTermsFrom({ holder: { min: 1000, decimals: 18, heldForSeconds: 86_400 } })).toBeNull();
    expect(holderTermsFrom({ holder: { min: "1e6", decimals: 18, heldForSeconds: 86_400 } })).toBeNull();
    expect(holderTermsFrom({ holder: { min: "1000", decimals: 18, heldForSeconds: 0 } })).toBeNull();
  });
});

describe("the holder rule", () => {
  it("groups whole HYVO and keeps a fraction without its trailing zeros", () => {
    expect(formatHyvo("1000000")).toBe("1,000,000");
    expect(formatHyvo("999")).toBe("999");
    expect(formatHyvo("2500.50")).toBe("2,500.5");
    expect(formatHyvo("0.25")).toBe("0.25");
    expect(formatHyvo("007")).toBe("7");
    expect(formatHyvo("1000.000")).toBe("1,000");
  });

  it("says a holding period in the largest whole unit", () => {
    expect(durationText(86_400)).toBe("24 hours");
    expect(durationText(3_600)).toBe("1 hour");
    expect(durationText(604_800)).toBe("7 days");
    expect(durationText(1_800)).toBe("30 minutes");
    expect(durationText(90)).toBe("90 seconds");
  });

  it("states the terms in one sentence, and says when there are none", () => {
    expect(holderRule({ min: "1000000", decimals: 18, heldForSeconds: 86_400 })).toBe(
      "Hold at least 1,000,000 HYVO in one wallet, now and 24 hours earlier.",
    );
    expect(holderRule(null)).toBe(HOLDER_RULE_UNSET);
    expect(HOLDER_RULE_UNSET).toContain("set at the launch");
  });
});

describe("officialToken", () => {
  it("has nothing before the launch", () => {
    expect(officialToken("")).toBeNull();
  });

  it("links the address to the explorer and to Hyvo's own pages for it, as given", () => {
    const address = "0x4e70c0de4e70c0DE4e70c0De4E70C0de4E70c0de";
    expect(officialToken(address)).toEqual({
      address,
      explorerUrl: `https://robinhoodchain.blockscout.com/address/${address}`,
      explorerName: "Blockscout",
      checkPath: `/check/${address}`,
      launchPath: `/launches/${address}`,
    });
  });

  it("goes with one line that rates nothing and says nothing of where to trade", () => {
    expect(ONLY_TOKEN).toBe("This is Hyvo's only token. A token at any other address is not Hyvo's, whatever its name.");
    expect(ONLY_TOKEN).not.toMatch(/\b(buy|sell|price|safe|scam|rug|honeypot|legit|risky)\b/i);
  });
});
