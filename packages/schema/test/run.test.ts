import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ACTION_KINDS,
  ActionKind,
  Address,
  AgentId,
  DISCLAIMER,
  Decimal,
  Handle,
  Hash32,
  PERSONAS_LATER,
  PERSONAS_STAGE1,
  Persona,
  PersonaMix,
  PostId,
  RUN_VERSION,
  RunId,
  RunV1,
  Timestamp,
  TxHash,
} from "../src/index";
import { sampleRun } from "./fixtures";

type Mutation = (run: RunV1) => void;

const TX = `0x${"ab".repeat(32)}`;
const round = (run: RunV1, n: number) => run.rounds[n - 1]!;
const post = (run: RunV1, n: number, i: number) => round(run, n).posts[i]!;
const action = (run: RunV1, n: number, i: number) => round(run, n).actions[i]!;
const agent = (run: RunV1, i: number) => run.crowd.agents[i]!;

/** Issues RunV1 reports for the sample run after `mutate`; the run must be rejected. */
function issuesAfter(mutate: Mutation) {
  const run = sampleRun();
  mutate(run);
  const result = RunV1.safeParse(run);
  expect(result.success).toBe(false);
  return result.error?.issues ?? [];
}

describe("constants", () => {
  it("match docs/RUN_FORMAT.md", () => {
    expect(RUN_VERSION).toBe(1);
    expect(DISCLAIMER).toBe("Synthetic crowd reaction. Not a trading signal.");
    expect(PERSONAS_STAGE1).toEqual(["sniper", "holder", "panic_seller", "skeptic"]);
    expect(ACTION_KINDS).toEqual(["swap_buy", "swap_sell", "hold", "check_market"]);
  });

  it("define the persona and action enums", () => {
    expect(Persona.options).toEqual([...PERSONAS_STAGE1, ...PERSONAS_LATER, "clone"]);
    expect(PERSONAS_LATER).toEqual(["swing_trader", "whale", "kol_follower", "market_maker_bot", "stock_token_holder", "newcomer"]);
    expect(Object.keys(PersonaMix.shape)).toEqual([...PERSONAS_STAGE1, ...PERSONAS_LATER, "clone"]);
    expect(ActionKind.options).toEqual([...ACTION_KINDS]);
  });
});

describe("primitive formats", () => {
  const table: [name: string, schema: z.ZodType, valid: string[], invalid: string[]][] = [
    [
      "RunId",
      RunId,
      ["run_01JC8Z6Q3W1Y2V9K7T5R4N3M2P", "run_00000000000000000000000000", "run_7ZZZZZZZZZZZZZZZZZZZZZZZZZ"],
      [
        "run_01jc8z6q3w1y2v9k7t5r4n3m2p",
        "run_8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
        "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2",
        "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2PX",
        "run_01JC8Z6Q3W1Y2V9K7T5R4N3MIL",
        "run_01JC8Z6Q3W1Y2V9K7T5R4N3MOU",
        "01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
        "run-01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
      ],
    ],
    [
      "Timestamp",
      Timestamp,
      ["2026-11-03T10:00:00Z", "2028-02-29T23:59:59Z", "2000-01-01T00:00:00Z"],
      [
        "2026-11-03T10:00:00.000Z",
        "2026-11-03T10:00:00+00:00",
        "2026-11-03 10:00:00Z",
        "2026-11-03T10:00:00z",
        "2026-11-03T10:00Z",
        "2026-02-30T00:00:00Z",
        "2027-02-29T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-11-03T24:00:00Z",
        "2026-11-03T10:60:00Z",
        "2026-11-03T10:00:60Z",
        "٢٠٢٦-11-03T10:00:00Z",
      ],
    ],
    [
      "Address",
      Address,
      [
        "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        "0x5fbdb2315678afecb367f032d93f642f64180aa3",
        "0x0000000000000000000000000000000000000000",
      ],
      [
        "5FbDB2315678afecb367f032d93F642f64180aa3",
        "0X5FbDB2315678afecb367f032d93F642f64180aa3",
        "0x5FbDB2315678afecb367f032d93F642f64180aa",
        "0x5FbDB2315678afecb367f032d93F642f64180aa30",
        "0x5FbDB2315678afecb367f032d93F642f64180aag",
      ],
    ],
    [
      "Hash32",
      Hash32,
      [`0x${"0".repeat(64)}`, TX],
      [`0x${"AB".repeat(32)}`, `0x${"a".repeat(63)}`, `0x${"a".repeat(65)}`, "ab".repeat(32)],
    ],
    ["TxHash", TxHash, [TX], [`0x${"aB".repeat(32)}`]],
    [
      "Decimal",
      Decimal,
      ["0", "10", "0.05", "123.456", "1000000", "0.000000000000000001"],
      ["1.50", ".5", "01", "00", "1.", "0.0", "1.0", "-1", "+1", "1e3", "1,000", "", " 1"],
    ],
    ["AgentId", AgentId, ["a01", "a07", "a99", "a100", "a9999"], ["a1", "a12345", "A01", "b01", "a0x"]],
    ["PostId", PostId, ["p1", "c12", "p007"], ["p", "x1", "P1", "p-1", "p1a"]],
    [
      "Handle",
      Handle,
      ["@quietferret42", "@abc", "@a_b_c", `@${"a".repeat(30)}`],
      ["quietferret42", "@ab", `@${"a".repeat(31)}`, "@Quiet", "@quiet-ferret", "@quiet.ferret"],
    ],
  ];

  describe.each(table)("%s", (_name, schema, valid, invalid) => {
    it.each(valid)("accepts %j", (value) => {
      expect(schema.safeParse(value).success).toBe(true);
    });
    it.each(invalid)("rejects %j", (value) => {
      expect(schema.safeParse(value).success).toBe(false);
    });
  });
});

describe("RunV1", () => {
  it("accepts the sample run", () => {
    expect(RunV1.safeParse(sampleRun()).error?.issues).toBeUndefined();
  });

  it("returns the document unchanged, so the parsed value hashes like the input", () => {
    expect(RunV1.parse(sampleRun())).toEqual(sampleRun());
  });

  it("accepts a partial run stopped before its first round", () => {
    const run = sampleRun();
    Object.assign(run, { status: "partial", stopReason: "max_llm_calls", rounds: [] });
    Object.assign(run.report, { sentimentByRound: [], turningPoint: null });
    expect(RunV1.safeParse(run).error?.issues).toBeUndefined();
  });

  it("never throws on malformed input", () => {
    for (const input of [null, 42, "run", [], {}, { ...sampleRun(), rounds: "none" }]) {
      expect(RunV1.safeParse(input).success).toBe(false);
    }
  });
});

describe("strict objects", () => {
  const targets: [label: string, pick: (run: RunV1) => object][] = [
    ["the document", (run) => run],
    ["scenario", (run) => run.scenario],
    ["scenario.seedSources[0]", (run) => run.scenario.seedSources[0]!],
    ["scenario.injectedEvents[0]", (run) => run.scenario.injectedEvents[0]!],
    ["world", (run) => run.world],
    ["world.pools[0]", (run) => run.world.pools[0]!],
    ["world.token", (run) => run.world.token],
    ["world.quote", (run) => run.world.quote],
    ["crowd", (run) => run.crowd],
    ["crowd.personaMix", (run) => run.crowd.personaMix],
    ["crowd.model", (run) => run.crowd.model],
    ["crowd.agents[0]", (run) => agent(run, 0)],
    ["rounds[0]", (run) => round(run, 1)],
    ["rounds[0].posts[0]", (run) => post(run, 1, 0)],
    ["rounds[0].actions[0]", (run) => action(run, 1, 0)],
    ["rounds[0].market", (run) => round(run, 1).market],
    ["report", (run) => run.report],
    ["report.turningPoint", (run) => run.report.turningPoint!],
    ["usage", (run) => run.usage],
  ];

  it.each(targets)("rejects an unknown key in %s", (_label, pick) => {
    const issues = issuesAfter((run) => Object.assign(pick(run), { unexpected: true }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "unrecognized_keys", keys: ["unexpected"] }));
  });
});

describe("RunV1 refinements", () => {
  const cases: [label: string, mutate: Mutation, path: PropertyKey[], message: RegExp][] = [
    ["a complete run with a stop reason", (run) => { run.stopReason = "timeout"; }, ["stopReason"], /must be null when status is "complete"/],
    ["a partial run without a stop reason", (run) => { run.status = "partial"; }, ["stopReason"], /is required when status is "partial"/],
    ["personaMix not summing to size", (run) => { run.crowd.personaMix.skeptic = 1; }, ["crowd", "personaMix"], /must sum to crowd\.size \(3\), got 4/],
    ["personaMix disagreeing with agent personas", (run) => { Object.assign(run.crowd.personaMix, { sniper: 2, holder: 0 }); }, ["crowd", "personaMix", "holder"], /is 0 but crowd\.agents has 1 with this persona/],
    ["agents.length different from size", (run) => { run.crowd.size = 4; }, ["crowd", "agents"], /must have crowd\.size \(4\) entries, got 3/],
    ["duplicate agent ids", (run) => { agent(run, 2).agentId = "a02"; }, ["crowd", "agents", 2, "agentId"], /duplicate agent id a02/],
    ["an agent id padded to the wrong width", (run) => { agent(run, 0).agentId = "a001"; }, ["crowd", "agents", 0, "agentId"], /must have 2 digits for a crowd of 3/],
    ["rounds not numbered from 1", (run) => { round(run, 1).n = 2; round(run, 2).n = 3; }, ["rounds", 0, "n"], /must be 1/],
    ["rounds not consecutive", (run) => { round(run, 2).n = 3; }, ["rounds", 1, "n"], /must be 2/],
    ["sentimentByRound length different from rounds", (run) => { run.report.sentimentByRound.push(0); }, ["report", "sentimentByRound"], /one value per round \(2\), got 3/],
    ["a post by an unknown agent", (run) => { post(run, 1, 0).agentId = "a04"; }, ["rounds", 0, "posts", 0, "agentId"], /unknown agent a04/],
    ["an action by an unknown agent", (run) => { action(run, 1, 1).agentId = "a04"; }, ["rounds", 0, "actions", 1, "agentId"], /unknown agent a04/],
    ["duplicate post ids", (run) => { post(run, 1, 2).id = "p1"; }, ["rounds", 0, "posts", 2, "id"], /duplicate post id p1/],
    ["a reply to a later post in the same round", (run) => { post(run, 1, 1).replyTo = "p2"; }, ["rounds", 0, "posts", 1, "replyTo"], /earlier post, got p2/],
    ["a reply to a post in a later round", (run) => { post(run, 1, 1).replyTo = "p3"; }, ["rounds", 0, "posts", 1, "replyTo"], /earlier post, got p3/],
    ["a reply to itself", (run) => { post(run, 2, 1).replyTo = "c2"; }, ["rounds", 1, "posts", 1, "replyTo"], /earlier post, got c2/],
    ["a reply to an unknown post", (run) => { post(run, 2, 1).replyTo = "p99"; }, ["rounds", 1, "posts", 1, "replyTo"], /earlier post, got p99/],
    ["a top-level post with a reply id", (run) => { post(run, 1, 2).id = "c9"; }, ["rounds", 0, "posts", 2, "id"], /"p<n>" for a top-level post/],
    ["a reply with a top-level id", (run) => { post(run, 1, 1).id = "p9"; }, ["rounds", 0, "posts", 1, "id"], /"c<n>" for a reply/],
    ["check_market with amountIn", (run) => { action(run, 1, 1).amountIn = "1"; }, ["rounds", 0, "actions", 1, "amountIn"], /must be null for check_market/],
    ["check_market with amountOut", (run) => { action(run, 1, 1).amountOut = "1"; }, ["rounds", 0, "actions", 1, "amountOut"], /must be null for check_market/],
    ["hold with amountIn", (run) => { action(run, 2, 2).amountIn = "2"; }, ["rounds", 1, "actions", 2, "amountIn"], /must be null for hold/],
    ["hold with amountOut", (run) => { action(run, 2, 2).amountOut = "1"; }, ["rounds", 1, "actions", 2, "amountOut"], /must be null for hold/],
    ["check_market with a txHash", (run) => { action(run, 1, 1).txHash = TX; }, ["rounds", 0, "actions", 1, "txHash"], /must be null for check_market/],
    ["an executed swap without amountIn", (run) => { action(run, 1, 0).amountIn = null; }, ["rounds", 0, "actions", 0, "amountIn"], /is required for an executed swap/],
    ["an executed swap without amountOut", (run) => { action(run, 2, 0).amountOut = null; }, ["rounds", 1, "actions", 0, "amountOut"], /is required for an executed swap/],
    ["an executed swap without txHash", (run) => { action(run, 1, 2).txHash = null; }, ["rounds", 0, "actions", 2, "txHash"], /is required for an executed swap/],
    ["a reverted check_market", (run) => { action(run, 1, 1).status = "reverted"; }, ["rounds", 0, "actions", 1, "status"], /only a sent swap can revert/],
    ["a reverted swap without txHash", (run) => { action(run, 2, 1).txHash = null; }, ["rounds", 1, "actions", 1, "txHash"], /is required for a reverted swap/],
    ["an invalid action not recorded as hold", (run) => { action(run, 2, 2).kind = "swap_buy"; }, ["rounds", 1, "actions", 2, "kind"], /must be "hold"/],
    ["an invalid check_market", (run) => { Object.assign(action(run, 1, 1), { status: "invalid", note: "x" }); }, ["rounds", 0, "actions", 1, "kind"], /must be "hold"/],
    ["an invalid action without a note", (run) => { action(run, 2, 2).note = null; }, ["rounds", 1, "actions", 2, "note"], /must say why/],
    ["an agent without an action in a round", (run) => { round(run, 2).actions.pop(); }, ["rounds", 1, "actions"], /missing an action for a02/],
    ["an agent with two actions in a round", (run) => { action(run, 1, 1).agentId = "a01"; }, ["rounds", 0, "actions", 1, "agentId"], /a01 already has an action/],
    ["more holders than agents", (run) => { round(run, 1).market.holders = 4; }, ["rounds", 0, "market", "holders"], /cannot exceed crowd\.size \(3\)/],
    ["a turning point after the last round", (run) => { run.report.turningPoint = { round: 3, why: "later" }; }, ["report", "turningPoint", "round"], /existing round \(1 to 2\)/],
    ["a different disclaimer", (run) => { Object.assign(run.report, { disclaimer: "Not financial advice." }); }, ["report", "disclaimer"], /Invalid input/],
    ["costUsd with more than 6 decimals", (run) => { run.usage.costUsd = 0.0004081; }, ["usage", "costUsd"], /rounded to 6 decimals/],
    ["initial holders disagreeing with seeded agents", (run) => { agent(run, 0).startTokens = "10"; }, ["world", "initialMarket", "holders"], /startTokens > 0 \(1\)/],
    ["sentiment with 5 decimals", (run) => { run.report.sentimentByRound[0] = 0.12345; }, ["report", "sentimentByRound", 0], /at most 4 decimal places/],
  ];

  it.each(cases)("rejects %s", (_label, mutate, path, message) => {
    expect(issuesAfter(mutate)).toContainEqual(
      expect.objectContaining({ path, message: expect.stringMatching(message) }),
    );
  });
});

describe("RunV1 field rules", () => {
  const cases: [label: string, mutate: Mutation, path: PropertyKey[]][] = [
    ["version 2", (run) => { Object.assign(run, { version: 2 }); }, ["version"]],
    ["createdAt with milliseconds", (run) => { run.createdAt = "2026-11-02T12:00:00.000Z"; }, ["createdAt"]],
    ["an uppercase hash", (run) => { run.hash = `0x${run.hash.slice(2).toUpperCase()}`; }, ["hash"]],
    ["an unknown stop reason", (run) => { Object.assign(run, { status: "partial", stopReason: "crash" }); }, ["stopReason"]],
    ["an unknown seed source kind", (run) => { Object.assign(run.scenario.seedSources[0]!, { kind: "x" }); }, ["scenario", "seedSources", 0, "kind"]],
    ["an injected event in round 0", (run) => { run.scenario.injectedEvents[0]!.round = 0; }, ["scenario", "injectedEvents", 0, "round"]],
    ["no pools", (run) => { run.world.pools = []; }, ["world", "pools"]],
    ["a fee above 10000 bps", (run) => { run.world.pools[0]!.feeBps = 10_001; }, ["world", "pools", 0, "feeBps"]],
    ["an unknown pool kind", (run) => { Object.assign(run.world.pools[0]!, { kind: "v3" }); }, ["world", "pools", 0, "kind"]],
    ["a negative fork block", (run) => { run.world.forkBlock = -1; }, ["world", "forkBlock"]],
    ["token decimals above 255", (run) => { run.world.token.decimals = 256; }, ["world", "token", "decimals"]],
    ["an unknown persona", (run) => { Object.assign(agent(run, 0), { persona: "wizard" }); }, ["crowd", "agents", 0, "persona"]],
    ["an empty model name", (run) => { run.crowd.model.agents = ""; }, ["crowd", "model", "agents"]],
    ["negative likes", (run) => { post(run, 1, 0).likes = -1; }, ["rounds", 0, "posts", 0, "likes"]],
    ["an unknown action kind", (run) => { Object.assign(action(run, 1, 1), { kind: "swap" }); }, ["rounds", 0, "actions", 1, "kind"]],
    ["an amount with a trailing zero", (run) => { action(run, 1, 0).amountIn = "0.50"; }, ["rounds", 0, "actions", 0, "amountIn"]],
    ["an empty note", (run) => { action(run, 2, 2).note = ""; }, ["rounds", 1, "actions", 2, "note"]],
    ["fractional holders", (run) => { round(run, 1).market.holders = 1.5; }, ["rounds", 0, "market", "holders"]],
    ["sentiment above 1", (run) => { run.report.sentimentByRound[0] = 1.5; }, ["report", "sentimentByRound", 0]],
    ["sentiment below -1", (run) => { run.report.sentimentByRound[1] = -1.01; }, ["report", "sentimentByRound", 1]],
    ["negative costUsd", (run) => { run.usage.costUsd = -0.000001; }, ["usage", "costUsd"]],
    ["fractional llmCalls", (run) => { run.usage.llmCalls = 2.5; }, ["usage", "llmCalls"]],
    ["a missing initialMarket", (run) => { delete (run.world as Partial<RunV1["world"]>).initialMarket; }, ["world", "initialMarket"]],
    ["a missing startEth", (run) => { delete (agent(run, 0) as Partial<RunV1["crowd"]["agents"][number]>).startEth; }, ["crowd", "agents", 0, "startEth"]],
    ["startTokens with a trailing zero", (run) => { agent(run, 1).startTokens = "5.0"; }, ["crowd", "agents", 1, "startTokens"]],
    ["six objections", (run) => { run.report.objections = Array.from({ length: 6 }, (_, i) => `objection ${i}`); }, ["report", "objections"]],
    ["six price drivers", (run) => { run.report.priceDrivers = Array.from({ length: 6 }, (_, i) => `driver ${i}`); }, ["report", "priceDrivers"]],
  ];

  it.each(cases)("rejects %s", (_label, mutate, path) => {
    expect(issuesAfter(mutate).map((issue) => issue.path)).toContainEqual(path);
  });
});

describe("text lengths count code points, as Python len() does", () => {
  const rocket = "\u{1F680}"; // one code point, two UTF-16 code units
  const fields: [label: string, min: number, max: number, set: (run: RunV1, text: string) => void][] = [
    ["scenario.title", 1, 200, (run, text) => { run.scenario.title = text; }],
    ["scenario.seedText", 0, 4000, (run, text) => { run.scenario.seedText = text; }],
    ["scenario.injectedEvents[].text", 1, 500, (run, text) => { run.scenario.injectedEvents[0]!.text = text; }],
    ["report.summary", 0, 1500, (run, text) => { run.report.summary = text; }],
    ["report.turningPoint.why", 0, 800, (run, text) => { run.report.turningPoint!.why = text; }],
    ["report.objections[]", 0, 400, (run, text) => { run.report.objections[0] = text; }],
    ["report.priceDrivers[]", 0, 400, (run, text) => { run.report.priceDrivers[0] = text; }],
  ];

  it.each(fields)("%s holds %i to %i characters", (_label, min, max, set) => {
    const accepts = (text: string) => {
      const run = sampleRun();
      set(run, text);
      return RunV1.safeParse(run).success;
    };
    expect(accepts(rocket.repeat(max))).toBe(true);
    expect(accepts(rocket.repeat(max + 1))).toBe(false);
    expect(accepts("x".repeat(min))).toBe(true);
    if (min > 0) expect(accepts("x".repeat(min - 1))).toBe(false);
  });
});

describe("replies", () => {
  it("accepts a reply to an earlier reply", () => {
    const run = sampleRun();
    post(run, 2, 1).replyTo = "c1";
    expect(RunV1.safeParse(run).error?.issues).toBeUndefined();
  });
});

describe("agent ids are zero-padded to max(2, digits(size))", () => {
  /** The sample with a crowd of `size` snipers whose ids have `width` digits, and no rounds. */
  function crowdOf(size: number, width: number): RunV1 {
    const run = sampleRun();
    run.crowd.size = size;
    run.crowd.personaMix = { sniper: size, holder: 0, panic_seller: 0, skeptic: 0 };
    run.crowd.agents = Array.from({ length: size }, (_, i) => ({
      agentId: `a${String(i + 1).padStart(width, "0")}`,
      handle: `@agent_${i + 1}`,
      persona: "sniper" as const,
      startEth: "1",
      startTokens: "0",
    }));
    run.rounds = [];
    Object.assign(run.report, { sentimentByRound: [], turningPoint: null });
    return run;
  }

  it.each([
    [1, 2],
    [9, 2],
    [10, 2],
    [99, 2],
    [100, 3],
    [999, 3],
    [1000, 4],
  ])("a crowd of %i uses %i digits", (size, width) => {
    expect(RunV1.safeParse(crowdOf(size, width)).error?.issues).toBeUndefined();
    expect(RunV1.safeParse(crowdOf(size, width + 1)).success).toBe(false);
    if (width > 2) expect(RunV1.safeParse(crowdOf(size, width - 1)).success).toBe(false);
  });
});

describe("the later personas", () => {
  function withWhale(): RunV1 {
    const run = sampleRun();
    const moved = agent(run, 0).persona;
    agent(run, 0).persona = "whale";
    run.crowd.personaMix[moved] -= 1;
    run.crowd.personaMix.whale = 1;
    return run;
  }

  it("are read when the mix counts them", () => {
    expect(RunV1.safeParse(withWhale()).success).toBe(true);
  });

  it("are refused when the mix does not count them", () => {
    const run = withWhale();
    delete run.crowd.personaMix.whale;
    const issues = RunV1.safeParse(run).error!.issues.map((issue) => issue.path.join("."));
    expect(issues).toContain("crowd.personaMix.whale");
  });

  it("are not needed in a run that has none", () => {
    const run = sampleRun();
    expect(Object.keys(run.crowd.personaMix)).toEqual([...PERSONAS_STAGE1]);
    expect(RunV1.safeParse(run).success).toBe(true);
  });

  it("are refused under a name the format does not know", () => {
    const run = sampleRun();
    Object.assign(run.crowd.personaMix, { wizard: 0 });
    expect(RunV1.safeParse(run).success).toBe(false);
  });
});
