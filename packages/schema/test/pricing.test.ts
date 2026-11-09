import { describe, expect, it } from "vitest";
import { estimatedCostUsd, HealthResponse, PriceTerms, runPriceUsd } from "../src/index";

/** The defaults of apps/api/wrangler.jsonc, and the costs of production.vars.json. */
const DEFAULTS: PriceTerms = { multiplier: 2.5, floorUsd: 1, stepUsd: 1, costPerAgentRoundUsd: 0.0003, reportCostUsd: 0.02 };
const PRODUCTION: PriceTerms = { ...DEFAULTS, costPerAgentRoundUsd: 0.00005, reportCostUsd: 0.008 };

describe("a run's price", () => {
  it("is the estimate times the multiplier, rounded up to the step, and never under the floor", () => {
    expect(estimatedCostUsd(DEFAULTS, { agents: 50, rounds: 10 })).toBe(0.17);
    // 0.17 x 2.5 = 0.425: under the floor.
    expect(runPriceUsd(DEFAULTS, { agents: 50, rounds: 10 })).toBe(1);
    // 2000 x 30 x 0.0003 + 0.02 = 18.02; x 2.5 = 45.05, up to 46.
    expect(runPriceUsd(DEFAULTS, { agents: 2000, rounds: 30 })).toBe(46);
    expect(runPriceUsd(PRODUCTION, { agents: 50, rounds: 10 })).toBe(1);
  });

  it("takes a holder's discount before the step and the floor", () => {
    expect(runPriceUsd(DEFAULTS, { agents: 2000, rounds: 30 }, 2000)).toBe(37); // 45.05 x 0.8 = 36.04
    expect(runPriceUsd(DEFAULTS, { agents: 50, rounds: 10 }, 2000)).toBe(1);
    expect(runPriceUsd(DEFAULTS, { agents: 50, rounds: 10 }, 10_000)).toBe(1);
  });

  it("does not add a step for float noise, and keeps whole cents", () => {
    // 0.1 x 3 is 0.30000000000000004 in floats: still three steps of 0.1, not four.
    const terms: PriceTerms = { multiplier: 3, floorUsd: 0, stepUsd: 0.1, costPerAgentRoundUsd: 0, reportCostUsd: 0.1 };
    expect(runPriceUsd(terms, { agents: 10, rounds: 3 })).toBe(0.3);
    // 200 x 10 x 0.0003 + 0.02 = 0.62; x 2.5 = 1.55, up to the next quarter.
    expect(runPriceUsd({ ...DEFAULTS, floorUsd: 0, stepUsd: 0.25 }, { agents: 200, rounds: 10 })).toBe(1.75);
  });
});

describe("/v1/health", () => {
  const base = {
    ok: true,
    version: "0.3.0",
    features: { payments: true, oracle: true, holder: true, clone: false },
    limits: { minAgents: 10, maxAgents: 2000, minRounds: 3, maxRounds: 30, maxDecisions: 840 },
  };

  it("reads an API older than the holder and pricing fields", () => {
    expect(HealthResponse.parse(base)).toEqual(base);
  });

  it("reads the holder terms and the price terms", () => {
    const body = { ...base, holder: { min: "1000", decimals: 18, heldForSeconds: 86_400 }, pricing: PRODUCTION };
    expect(HealthResponse.parse(body)).toEqual(body);
    expect(HealthResponse.parse({ ...base, holder: null }).holder).toBeNull();
  });

  it("refuses a minimum that is not a plain decimal number", () => {
    for (const min of ["1,000", "1e3", "-1", ""]) {
      expect(HealthResponse.safeParse({ ...base, holder: { min, decimals: 18, heldForSeconds: 86_400 } }).success, min).toBe(false);
    }
  });
});
