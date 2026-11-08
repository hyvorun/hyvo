/**
 * zod schemas for `run.json` v1. The normative format is docs/RUN_FORMAT.md.
 *
 * Every object is strict: unknown keys are rejected. Rules that span several fields are
 * refinements. JSON Schema cannot express those, so run.schema.json (which the Python engine
 * validates against) carries only the per-field rules; `RunV1` is the complete check.
 */
import { z } from "zod";

export const RUN_VERSION = 1;
export const DISCLAIMER = "Synthetic crowd reaction. Not a trading signal.";
export const PERSONAS_STAGE1 = ["sniper", "holder", "panic_seller", "skeptic"] as const;
/** Added later. `crowd.personaMix` lists one only when the crowd has it, so a run from before them reads and hashes as it did. */
export const PERSONAS_LATER = ["swing_trader", "whale", "kol_follower", "market_maker_bot", "stock_token_holder", "newcomer"] as const;
export const PERSONAS = [...PERSONAS_STAGE1, ...PERSONAS_LATER] as const;
/** An agent that trades by one wallet's statistics (SPEC 11.3). A run has at most one, and a mix cannot ask for it. */
export const CLONE_PERSONA = "clone";
export const RUN_PERSONAS = [...PERSONAS, CLONE_PERSONA] as const;
export const ACTION_KINDS = ["swap_buy", "swap_sell", "hold", "check_market"] as const;

// ---------------------------------------------------------------------------------------------
// Primitives. Digits are spelled [0-9] rather than \d because Python's `re`, which applies
// run.schema.json on the engine side, lets \d match any Unicode digit.

/** `run_` + a ULID in uppercase Crockford base32. A ULID is 128 bits, so it starts with 0-7. */
export const RunId = z.string().regex(/^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

/** UTC with seconds precision, such as `2026-11-03T10:00:00Z`, and a real calendar time. */
export const Timestamp = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/)
  .refine(isCalendarTime, "must be a real UTC date and time");

/** EVM address. The engine writes EIP-55 checksummed addresses; the checksum is not verified here. */
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** 32 bytes as lowercase hex. */
export const Hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
export const TxHash = Hash32;

/** Non-negative amount in whole units: no exponent, no leading zeros, no trailing fractional zeros. */
export const Decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/);

/** `a` + digits, zero-padded to max(2, digits(crowd.size)); `RunV1` checks the width. */
export const AgentId = z.string().regex(/^a[0-9]{2,4}$/);

/** `p<n>` for a top-level post, `c<n>` for a reply (comment). */
export const PostId = z.string().regex(/^[pc][0-9]+$/);

/** Generated handle, never a real person. */
export const Handle = z.string().regex(/^@[a-z0-9_]{3,30}$/);

export const Persona = z.enum(RUN_PERSONAS);
export const ActionKind = z.enum(ACTION_KINDS);
export const ActionStatus = z.enum(["ok", "reverted", "invalid"]);
export const RunStatus = z.enum(["complete", "partial"]);
export const StopReason = z.enum(["max_cost_usd", "max_llm_calls", "timeout"]);

const Count = z.int().nonnegative();
const RoundNumber = z.int().min(1);
const TokenDecimals = z.int().min(0).max(255);

/**
 * A string of `min` to `max` characters, counted in Unicode code points the way Python `len()`
 * and JSON Schema `maxLength` count them (UTF-16 `.length` would count an emoji twice).
 */
function text(min: number, max: number) {
  return z
    .string()
    .refine((s) => {
      const length = [...s].length;
      return length >= min && length <= max;
    }, `must be ${min} to ${max} characters long`)
    .meta({ minLength: min, maxLength: max });
}

function isCalendarTime(s: string): boolean {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s.replace("Z", ".000Z");
}

// ---------------------------------------------------------------------------------------------
// Scenario

export const SeedSource = z.strictObject({
  kind: z.enum(["url", "onchain", "user"]),
  ref: z.string(),
});

export const InjectedEvent = z.strictObject({
  round: RoundNumber,
  text: text(1, 500),
});

export const Scenario = z.strictObject({
  title: text(1, 200),
  seedText: text(0, 4000),
  seedSources: z.array(SeedSource),
  injectedEvents: z.array(InjectedEvent),
});

// ---------------------------------------------------------------------------------------------
// World

export const Pool = z.strictObject({
  address: Address,
  token0: Address,
  token1: Address,
  kind: z.enum(["v2-test", "real"]),
  feeBps: z.int().min(0).max(10_000),
});

export const Token = z.strictObject({
  address: Address,
  symbol: z.string(),
  name: z.string(),
  decimals: TokenDecimals,
});

export const QuoteToken = z.strictObject({
  address: Address,
  symbol: z.string(),
  decimals: TokenDecimals,
});

/** Pool state: after a round, or `world.initialMarket` before round 1. */
export const Market = z.strictObject({
  price: Decimal,
  reserve0: Decimal,
  reserve1: Decimal,
  holders: Count,
});

export const World = z.strictObject({
  chainId: z.int().positive(),
  forkBlock: z.int().nonnegative().nullable(),
  pools: z.array(Pool).min(1),
  token: Token,
  quote: QuoteToken,
  /** The pool after deploy, initial liquidity and agent token seeding, before round 1. */
  initialMarket: Market,
});

// ---------------------------------------------------------------------------------------------
// Crowd

export const Agent = z.strictObject({
  agentId: AgentId,
  handle: Handle,
  persona: Persona,
  /** Balances before round 1: ETH and tokens, in whole units. */
  startEth: Decimal,
  startTokens: Decimal,
});

export const PersonaMix = z.strictObject({
  sniper: Count,
  holder: Count,
  panic_seller: Count,
  skeptic: Count,
  swing_trader: Count.optional(),
  whale: Count.optional(),
  kol_follower: Count.optional(),
  market_maker_bot: Count.optional(),
  stock_token_holder: Count.optional(),
  newcomer: Count.optional(),
  clone: Count.max(1).optional(),
});

export const CrowdModel = z.strictObject({
  agents: z.string().min(1),
  report: z.string().min(1),
  temperature: z.number().nonnegative(),
});

export const Crowd = z.strictObject({
  size: z.int().min(1),
  personaMix: PersonaMix,
  model: CrowdModel,
  agents: z.array(Agent),
});

// ---------------------------------------------------------------------------------------------
// Rounds

export const Post = z
  .strictObject({
    id: PostId,
    agentId: AgentId,
    text: z.string(),
    replyTo: PostId.nullable(),
    likes: Count,
  })
  .refine((post) => post.id.startsWith("c") === (post.replyTo !== null), {
    error: 'must be "p<n>" for a top-level post and "c<n>" for a reply',
    path: ["id"],
  });

export const Action = z
  .strictObject({
    agentId: AgentId,
    kind: ActionKind,
    amountIn: Decimal.nullable(),
    amountOut: Decimal.nullable(),
    txHash: TxHash.nullable(),
    status: ActionStatus,
    note: z.string().min(1).nullable(),
  })
  .superRefine((action, ctx) => {
    const fail = (field: keyof typeof action, message: string) =>
      ctx.addIssue({ code: "custom", path: [field], message });
    const isSwap = action.kind === "swap_buy" || action.kind === "swap_sell";
    const swapFields = ["amountIn", "amountOut", "txHash"] as const;

    if (!isSwap) {
      // hold and check_market move no amounts and send no transaction.
      for (const field of swapFields) {
        if (action[field] !== null) fail(field, `must be null for ${action.kind}`);
      }
    } else if (action.status === "ok") {
      for (const field of swapFields) {
        if (action[field] === null) fail(field, "is required for an executed swap");
      }
    }
    if (action.status === "reverted") {
      if (!isSwap) fail("status", "only a sent swap can revert");
      else if (action.txHash === null) fail("txHash", "is required for a reverted swap");
    }
    if (action.status === "invalid") {
      if (action.kind !== "hold") fail("kind", 'must be "hold": invalid actions are converted to hold');
      if (action.note === null) fail("note", "must say why the action was invalid");
    }
  });

export const Round = z.strictObject({
  n: RoundNumber,
  posts: z.array(Post),
  actions: z.array(Action),
  market: Market,
});

// ---------------------------------------------------------------------------------------------
// Report and usage

export const TurningPoint = z.strictObject({
  round: RoundNumber,
  why: text(0, 800),
});

/** Mean agent sentiment of a round, in [-1, 1] with at most 4 decimal places. */
const Sentiment = z
  .number()
  .min(-1)
  .max(1)
  .refine((value) => Number(value.toFixed(4)) === value, "must have at most 4 decimal places");

export const Report = z.strictObject({
  summary: text(0, 1500),
  turningPoint: TurningPoint.nullable(),
  sentimentByRound: z.array(Sentiment),
  objections: z.array(text(0, 400)).max(5),
  priceDrivers: z.array(text(0, 400)).max(5),
  disclaimer: z.literal(DISCLAIMER),
  flags: z.array(z.string()),
});

export const Usage = z.strictObject({
  llmCalls: Count,
  inputTokens: Count,
  outputTokens: Count,
  costUsd: z
    .number()
    .nonnegative()
    .refine((usd) => Number(usd.toFixed(6)) === usd, "must be rounded to 6 decimals"),
});

// ---------------------------------------------------------------------------------------------
// Document

// ---------------------------------------------------------------------------------------------
// A scenario question: what each agent expects, hashed with the run before the outcome is known

export const CrowdAnswer = z.enum(["yes", "no", "unsure"]);
export const CrowdExpectation = z.enum(["yes", "no", "split"]);

export const CrowdQuestion = z.strictObject({
  text: text(1, 300),
  /** After this time the outcome can go on-chain. It is also the commit's `resolvesAt`. */
  resolvesAt: Timestamp,
  answers: z.strictObject({ yes: Count, no: Count, unsure: Count }),
  byAgent: z.record(AgentId, CrowdAnswer),
  /** The lean: more yes than no, more no than yes, or split. */
  expectation: CrowdExpectation,
});

// A rewind (SPEC 11.4): a real pool's past, read from the chain before the run starts, and hashed with it.

export const RewindPoint = z.strictObject({
  block: z.int().nonnegative(),
  at: Timestamp,
  price: Decimal,
  reserveEth: Decimal,
  reserveToken: Decimal,
});

export const Rewind = z.strictObject({
  pool: Address,
  block: z.int().nonnegative(),
  at: Timestamp,
  hours: z.number().positive(),
  /** The one thing that differs from what happened. */
  change: text(1, 500),
  /** What the pool did, from `block` on: anyone can read these from the chain. */
  actual: z.array(RewindPoint).min(2),
});

const RunFields = z.strictObject({
  runId: RunId,
  version: z.literal(RUN_VERSION),
  createdAt: Timestamp,
  status: RunStatus,
  stopReason: StopReason.nullable(),
  scenario: Scenario,
  world: World,
  crowd: Crowd,
  rounds: z.array(Round),
  report: Report,
  usage: Usage,
  question: CrowdQuestion.optional(),
  rewind: Rewind.optional(),
  hash: Hash32,
});

export const RunV1 = RunFields.superRefine((run, ctx) => {
  const fail: Fail = (path, message) => ctx.addIssue({ code: "custom", path, message });
  checkQuestion(run, fail);
  checkRewind(run, fail);
  checkStatus(run, fail);
  checkCrowd(run.crowd, fail);
  checkStart(run, fail);
  checkRounds(run, fail);
  checkReport(run, fail);
});

type Fail = (path: PropertyKey[], message: string) => void;
type RunFields = z.infer<typeof RunFields>;

/** A rewind starts where the fork starts, and its path runs forward. */
function checkRewind(run: RunFields, fail: Fail): void {
  const rewind = run.rewind;
  if (!rewind) return;
  if (run.world.forkBlock !== rewind.block) fail(["rewind", "block"], "must be the block the run was forked at");
  if (rewind.actual[0]!.block !== rewind.block) fail(["rewind", "actual", 0, "block"], "must start at the rewind's block");
  rewind.actual.forEach((point, index) => {
    if (index > 0 && point.block <= rewind.actual[index - 1]!.block) fail(["rewind", "actual", index, "block"], "must come after the one before");
  });
}

/** The numbers are the answers, and the lean is the numbers. */
function checkQuestion(run: RunFields, fail: Fail): void {
  const question = run.question;
  if (!question) return;
  const counted = { yes: 0, no: 0, unsure: 0 };
  for (const { agentId } of run.crowd.agents) {
    const answer = question.byAgent[agentId];
    if (answer) counted[answer]++;
    else fail(["question", "byAgent", agentId], "has no answer");
  }
  if (Object.keys(question.byAgent).length !== run.crowd.agents.length) {
    fail(["question", "byAgent"], "must hold one answer per agent");
  }
  for (const answer of CrowdAnswer.options) {
    if (question.answers[answer] !== counted[answer]) {
      fail(["question", "answers", answer], `is ${question.answers[answer]} but byAgent has ${counted[answer]}`);
    }
  }
  const { yes, no } = question.answers;
  const lean = yes > no ? "yes" : no > yes ? "no" : "split";
  if (question.expectation !== lean) fail(["question", "expectation"], `must be "${lean}" for these answers`);
}

/** "partial" means stopped by budget or timeout, and `stopReason` says which. */
function checkStatus(run: RunFields, fail: Fail): void {
  if (run.status === "complete" && run.stopReason !== null) {
    fail(["stopReason"], 'must be null when status is "complete"');
  }
  if (run.status === "partial" && run.stopReason === null) {
    fail(["stopReason"], 'is required when status is "partial"');
  }
}

function checkCrowd(crowd: Crowd, fail: Fail): void {
  const { size, personaMix, agents } = crowd;
  const mixTotal = RUN_PERSONAS.reduce((sum, persona) => sum + (personaMix[persona] ?? 0), 0);
  if (mixTotal !== size) {
    fail(["crowd", "personaMix"], `must sum to crowd.size (${size}), got ${mixTotal}`);
  }
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.persona, (counts.get(agent.persona) ?? 0) + 1);
  for (const persona of RUN_PERSONAS) {
    const count = counts.get(persona) ?? 0;
    const mixed = personaMix[persona] ?? 0;
    if (count !== mixed) {
      fail(["crowd", "personaMix", persona], `is ${mixed} but crowd.agents has ${count} with this persona`);
    }
  }
  if (agents.length !== size) {
    fail(["crowd", "agents"], `must have crowd.size (${size}) entries, got ${agents.length}`);
  }
  const digits = Math.max(2, String(size).length);
  const seen = new Set<string>();
  agents.forEach((agent, i) => {
    if (seen.has(agent.agentId)) fail(["crowd", "agents", i, "agentId"], `duplicate agent id ${agent.agentId}`);
    seen.add(agent.agentId);
    if (agent.agentId.length - 1 !== digits) {
      fail(["crowd", "agents", i, "agentId"], `must have ${digits} digits for a crowd of ${size}`);
    }
  });
}

/** `world.initialMarket.holders` counts the agents that start with tokens. */
function checkStart(run: RunFields, fail: Fail): void {
  const seeded = run.crowd.agents.filter((agent) => agent.startTokens !== "0").length;
  if (run.world.initialMarket.holders !== seeded) {
    fail(
      ["world", "initialMarket", "holders"],
      `must equal the number of agents with startTokens > 0 (${seeded})`,
    );
  }
}

function checkRounds(run: RunFields, fail: Fail): void {
  const agentIds = new Set(run.crowd.agents.map((agent) => agent.agentId));
  const earlierPostIds = new Set<string>();

  run.rounds.forEach((round, r) => {
    const at = (...path: PropertyKey[]) => ["rounds", r, ...path];
    if (round.n !== r + 1) fail(at("n"), `must be ${r + 1}: rounds are numbered consecutively from 1`);

    round.posts.forEach((post, i) => {
      if (!agentIds.has(post.agentId)) fail(at("posts", i, "agentId"), `unknown agent ${post.agentId}`);
      if (post.replyTo !== null && !earlierPostIds.has(post.replyTo)) {
        fail(at("posts", i, "replyTo"), `must be the id of an earlier post, got ${post.replyTo}`);
      }
      if (earlierPostIds.has(post.id)) fail(at("posts", i, "id"), `duplicate post id ${post.id}`);
      earlierPostIds.add(post.id);
    });

    // One market decision per agent per round.
    const acted = new Set<string>();
    round.actions.forEach((action, i) => {
      if (!agentIds.has(action.agentId)) fail(at("actions", i, "agentId"), `unknown agent ${action.agentId}`);
      else if (acted.has(action.agentId)) {
        fail(at("actions", i, "agentId"), `agent ${action.agentId} already has an action in this round`);
      }
      acted.add(action.agentId);
    });
    const missing = [...agentIds].filter((id) => !acted.has(id));
    if (missing.length > 0) fail(at("actions"), `missing an action for ${missing.join(", ")}`);

    if (round.market.holders > run.crowd.size) {
      fail(at("market", "holders"), `cannot exceed crowd.size (${run.crowd.size})`);
    }
  });
}

function checkReport(run: RunFields, fail: Fail): void {
  const { report, rounds } = run;
  if (report.sentimentByRound.length !== rounds.length) {
    fail(
      ["report", "sentimentByRound"],
      `must have one value per round (${rounds.length}), got ${report.sentimentByRound.length}`,
    );
  }
  if (report.turningPoint !== null && report.turningPoint.round > rounds.length) {
    fail(["report", "turningPoint", "round"], `must be an existing round (1 to ${rounds.length})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Inferred types

export type RunId = z.infer<typeof RunId>;
export type Timestamp = z.infer<typeof Timestamp>;
export type Address = z.infer<typeof Address>;
export type Hash32 = z.infer<typeof Hash32>;
export type TxHash = z.infer<typeof TxHash>;
export type Decimal = z.infer<typeof Decimal>;
export type AgentId = z.infer<typeof AgentId>;
export type PostId = z.infer<typeof PostId>;
export type Handle = z.infer<typeof Handle>;
export type Persona = z.infer<typeof Persona>;
export type Rewind = z.infer<typeof Rewind>;
export type ActionKind = z.infer<typeof ActionKind>;
export type ActionStatus = z.infer<typeof ActionStatus>;
export type RunStatus = z.infer<typeof RunStatus>;
export type StopReason = z.infer<typeof StopReason>;
export type SeedSource = z.infer<typeof SeedSource>;
export type InjectedEvent = z.infer<typeof InjectedEvent>;
export type Scenario = z.infer<typeof Scenario>;
export type Pool = z.infer<typeof Pool>;
export type Token = z.infer<typeof Token>;
export type QuoteToken = z.infer<typeof QuoteToken>;
export type World = z.infer<typeof World>;
export type Agent = z.infer<typeof Agent>;
export type PersonaMix = z.infer<typeof PersonaMix>;
export type CrowdModel = z.infer<typeof CrowdModel>;
export type Crowd = z.infer<typeof Crowd>;
export type Post = z.infer<typeof Post>;
export type Action = z.infer<typeof Action>;
export type Market = z.infer<typeof Market>;
export type Round = z.infer<typeof Round>;
export type TurningPoint = z.infer<typeof TurningPoint>;
export type Report = z.infer<typeof Report>;
export type Usage = z.infer<typeof Usage>;
export type RunV1 = z.infer<typeof RunV1>;
