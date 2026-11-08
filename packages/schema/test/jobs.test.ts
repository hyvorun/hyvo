import { describe, expect, it } from "vitest";
import { CreateRunRequest, JobSpec, QuoteRequest, RunnerJob, ScenarioInput } from "../src/index";

const scenario = {
  title: "Fictional token FIZZ lists",
  seedText: "FIZZ is a fictional token made up for this test.",
  events: [{ round: 2, text: "A large wallet posts that it entered early." }],
  market: { tokenSymbol: "FIZZ", liquidityEth: "5", feeBps: 100 },
};

describe("ScenarioInput", () => {
  it("accepts a scenario and defaults events to none", () => {
    expect(ScenarioInput.parse(scenario).events).toHaveLength(1);
    expect(ScenarioInput.parse({ title: "T1", seedText: "" }).events).toEqual([]);
  });

  it("counts code points, like the engine", () => {
    expect(ScenarioInput.safeParse({ ...scenario, title: `A${"🙂".repeat(199)}` }).success).toBe(true);
    expect(ScenarioInput.safeParse({ ...scenario, title: `A${"🙂".repeat(200)}` }).success).toBe(false);
    expect(ScenarioInput.safeParse({ ...scenario, seedText: "x".repeat(4001) }).success).toBe(false);
  });

  it("needs a title with a letter or digit", () => {
    expect(ScenarioInput.safeParse({ ...scenario, title: "​" }).success).toBe(false);
    expect(ScenarioInput.safeParse({ ...scenario, title: "!!!" }).success).toBe(false);
  });

  it("refuses events the engine would sanitize to nothing", () => {
    expect(ScenarioInput.safeParse({ ...scenario, events: [{ round: 1, text: "\u200b" }] }).success).toBe(false);
    expect(ScenarioInput.safeParse({ ...scenario, events: [{ round: 1, text: "!" }] }).success).toBe(true);
  });

  it("caps events per round and in total", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ round: 1, text: `event ${i}` }));
    expect(ScenarioInput.safeParse({ ...scenario, events: six }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ round: (i % 20) + 1, text: `e${i}` }));
    expect(ScenarioInput.safeParse({ ...scenario, events: many }).success).toBe(false);
  });

  it.each([
    [{ tokenSymbol: "fizz" }],
    [{ tokenSymbol: "ABCDEFGHIJKL" }],
    [{ liquidityEth: "0" }],
    [{ liquidityEth: "0.0001" }],
    [{ liquidityTokens: "0.0001" }],
    [{ liquidityEth: "1e3" }],
    [{ liquidityEth: "2000000" }],
    [{ liquidityEth: "0.0000000000000000001" }],
    [{ feeBps: 1001 }],
    [{ surprise: 1 }],
  ])("rejects market %j", (market) => {
    expect(ScenarioInput.safeParse({ ...scenario, market }).success).toBe(false);
  });
});

describe("QuoteRequest", () => {
  it("accepts a request", () => {
    const quote = QuoteRequest.parse({ scenario, agents: 50, rounds: 10 });
    expect(quote.listed).toBeUndefined();
  });

  it("rejects events after the last round", () => {
    const result = QuoteRequest.safeParse({ scenario, agents: 50, rounds: 1 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("after the last round");
  });

  it("checks that the mix adds up to the crowd", () => {
    expect(QuoteRequest.safeParse({ scenario, agents: 10, rounds: 3, mix: { sniper: 4, skeptic: 6 } }).success).toBe(
      true,
    );
    expect(QuoteRequest.safeParse({ scenario, agents: 10, rounds: 3, mix: { sniper: 4 } }).success).toBe(false);
    expect(QuoteRequest.safeParse({ scenario, agents: 10, rounds: 3, mix: { whale: 10 } }).success).toBe(true);
    expect(QuoteRequest.safeParse({ scenario, agents: 10, rounds: 3, mix: { wizard: 10 } }).success).toBe(false);
  });
});

describe("CreateRunRequest", () => {
  it("is an order or a holder credit run", () => {
    expect(CreateRunRequest.safeParse({ orderId: `0x${"ab".repeat(32)}` }).success).toBe(true);
    expect(CreateRunRequest.safeParse({ credit: true, scenario, agents: 10, rounds: 3 }).success).toBe(true);
    expect(CreateRunRequest.safeParse({ credit: false, scenario, agents: 10, rounds: 3 }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ orderId: "0x12" }).success).toBe(false);
  });
});

describe("RunnerJob", () => {
  it("matches what the engine runner reads (engine/tests/runner/fake_api.py small_spec)", () => {
    const job = {
      runId: "run_01JBX8M0Q0S8V3W4X5Y6Z7A8B9",
      leaseId: "lease_0000000000000001",
      attempt: 1,
      heartbeatIntervalS: 15,
      timeoutS: 1800,
      spec: {
        version: 1,
        scenario: { ...scenario, market: { tokenSymbol: "FIZZ", liquidityEth: "5", feeBps: 100 } },
        agents: 6,
        rounds: 2,
        mix: null,
        batchSize: 10,
        maxCostUsd: 0.5,
        maxLlmCalls: 100,
        seed: 11,
      },
    };
    expect(RunnerJob.parse(job)).toEqual(job);
    expect(JobSpec.safeParse({ ...job.spec, version: 2 }).success).toBe(false);
  });
});
