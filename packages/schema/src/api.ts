/**
 * zod schemas of the API payloads (docs/API.md). The Worker validates what it sends with these,
 * and the web app parses what it receives with them.
 */
import { z } from "zod";
import { MixInput, QuestionInput, RewindInput, ScenarioInput } from "./jobs";
import { PriceTerms } from "./pricing";
import { Address, AgentId, CrowdExpectation, DISCLAIMER, Hash32, PersonaMix, RunId, RunStatus, StopReason, Timestamp } from "./run";

export const RunSummary = z.strictObject({
  runId: RunId,
  title: z.string(),
  createdAt: Timestamp,
  publishedAt: Timestamp,
  status: RunStatus,
  stopReason: StopReason.nullable(),
  crowdSize: z.int().min(1),
  rounds: z.int().nonnegative(),
  personaMix: PersonaMix,
  models: z.strictObject({ agents: z.string(), report: z.string() }),
  hash: Hash32,
  featured: z.boolean(),
  market: z.strictObject({
    symbol: z.string(),
    priceStart: z.string(),
    priceEnd: z.string(),
    /** Display only: computed with floats from the decimal strings. */
    priceChangePct: z.number(),
    swaps: z.int().nonnegative(),
    posts: z.int().nonnegative(),
  }),
  /** priceStart, then each round's price; floats for drawing only. */
  sparkline: z.array(z.number()),
  turningPointRound: z.int().min(1).nullable(),
  /** report.summary, at most 280 characters. */
  summary: z.string(),
  /** The run's question and the crowd's lean, when it was asked one. */
  question: z
    .strictObject({
      text: z.string(),
      resolvesAt: Timestamp,
      expectation: CrowdExpectation,
      yes: z.int().nonnegative(),
      no: z.int().nonnegative(),
      unsure: z.int().nonnegative(),
    })
    .optional(),
});

const Disclaimer = z.literal(DISCLAIMER);

export const QuestionOutcome = z.enum(["yes", "no", "void"]);
export const CalibrationResult = z.enum(["hit", "miss", "no_lean", "void"]);

export const RunListResponse = z.strictObject({
  runs: z.array(RunSummary),
  nextCursor: z.string().nullable(),
  disclaimer: Disclaimer,
});

export const FeaturedRunResponse = z.strictObject({
  run: RunSummary,
  disclaimer: Disclaimer,
});

export const ArtifactResponse = z.strictObject({
  url: z.url(),
  expiresAt: Timestamp,
});

export const PublishResponse = z.strictObject({
  runId: RunId,
  hash: Hash32,
  publishedAt: Timestamp,
});

export const ErrorResponse = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});

/** Whole tokens as a decimal string: "1000", "2.5". */
const DecimalText = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);

export const HealthResponse = z.strictObject({
  ok: z.literal(true),
  version: z.string(),
  /** What this API has switched on: a page can say so before asking for a wallet. */
  features: z.strictObject({ payments: z.boolean(), oracle: z.boolean(), holder: z.boolean(), clone: z.boolean() }),
  /** The largest run the API can quote; `maxDecisions` (agents x rounds) follows the daily LLM cap. */
  limits: z.strictObject({
    minAgents: z.int(),
    maxAgents: z.int(),
    minRounds: z.int(),
    maxRounds: z.int(),
    maxDecisions: z.int().nonnegative(),
  }),
  /**
   * Holder benefits, or null while they are off: a wallet qualifies holding at least `min` tokens (whole tokens, a
   * decimal string) both now and `heldForSeconds` ago. Missing from an API older than the field.
   */
  holder: z
    .strictObject({ min: DecimalText, decimals: z.int().min(0).max(255), heldForSeconds: z.int().positive() })
    .nullable()
    .optional(),
  /** The terms every run's price comes from (`runPriceUsd`), so a page can show it before anything is paid. */
  pricing: PriceTerms.optional(),
});

/** A `RunSummary` as derived from `run.json`, before the API adds `publishedAt` and `featured`. */
export const DerivedRunSummary = RunSummary.omit({ publishedAt: true, featured: true });

/**
 * What the runner reports about a run it verified. On the Workers Free plan the Worker does not
 * parse or re-hash the run (docs/OPEN_ITEMS.md item 21), so these come from the runner.
 */
export const RunMeta = z.strictObject({
  hash: Hash32,
  scenarioHash: Hash32,
  /** SHA-256 of the exact bytes uploaded: lowercase hex, no `0x`. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  summary: DerivedRunSummary,
  usage: z.strictObject({ costUsd: z.number().nonnegative(), llmCalls: z.int().nonnegative() }),
  /** The round of each injected event. */
  eventRounds: z.array(z.int().min(1)),
});

/** The metadata line of `POST /internal/runs/publish`. */
export const PublishMeta = z.strictObject({
  hash: Hash32,
  sha256: RunMeta.shape.sha256,
  summary: DerivedRunSummary,
  /** What an oracle commit of this run needs. Without it the run is published and not committed. */
  scenarioHash: Hash32.optional(),
  featured: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// Sign-in with Ethereum

export const NonceResponse = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9]{16,64}$/),
  expiresAt: Timestamp,
});

export const SiweVerifyRequest = z.strictObject({
  message: z.string().min(1).max(4000),
  signature: z.string().regex(/^0x[0-9a-fA-F]{2,8192}$/),
});

export const SessionResponse = z.strictObject({
  token: z.string().min(32),
  address: Address,
  expiresAt: Timestamp,
  admin: z.boolean(),
});

/** Holder benefits (SPEC 8.3): free small runs and a discount, never yield or payouts. */
export const HolderStatus = z.strictObject({
  enabled: z.boolean(),
  eligible: z.boolean(),
  /** Token units (decimal strings); balances are null when they could not be read. */
  minBalance: z.string(),
  balance: z.string().nullable(),
  balance24hAgo: z.string().nullable(),
  freeRunsPerMonth: z.int().nonnegative(),
  freeRunsLeft: z.int().nonnegative(),
  discountBps: z.int().min(0).max(10_000),
  freeRunMax: z.strictObject({ agents: z.int().min(1), rounds: z.int().min(1) }),
});

export const MeResponse = z.strictObject({
  address: Address,
  admin: z.boolean(),
  holder: HolderStatus,
});

// ---------------------------------------------------------------------------------------------
// Quotes, orders and payments

/** What to run. Crowd and round bounds come from the API config and are checked there. */
const RunRequestFields = {
  scenario: ScenarioInput,
  agents: z.int(),
  rounds: z.int(),
  mix: MixInput.nullable().optional(),
  listed: z.boolean().optional(),
  question: QuestionInput.optional(),
};

function checkRunRequest(
  request: { scenario: ScenarioInput; agents: number; rounds: number; mix?: MixInput | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const late = request.scenario.events.filter((event) => event.round > request.rounds);
  if (late.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["scenario", "events"],
      message: `events at round ${late.map((e) => e.round).join(", ")} fall after the last round (${request.rounds})`,
    });
  }
  if (request.mix) {
    const total = Object.values(request.mix).reduce<number>((sum, count) => sum + (count ?? 0), 0);
    if (total !== request.agents) {
      ctx.addIssue({ code: "custom", path: ["mix"], message: `the mix adds up to ${total}, not ${request.agents}` });
    }
  }
}

export const QuoteRequest = z.strictObject(RunRequestFields).superRefine(checkRunRequest);

export const PaymentToken = z.strictObject({ address: Address, symbol: z.string(), decimals: z.int() });

export const OrderStatus = z.enum(["quoted", "paid", "expired"]);

export const Order = z.strictObject({
  /** The PaymentRouter `orderId` (bytes32). */
  orderId: Hash32,
  status: OrderStatus,
  address: Address,
  token: PaymentToken,
  /** Token base units as a decimal string. */
  amount: z.string().regex(/^[0-9]+$/),
  priceUsd: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  discountBps: z.int().min(0).max(10_000),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  paidAt: Timestamp.nullable(),
  runId: RunId.nullable(),
  chainId: z.int(),
  paymentRouter: Address,
  run: z.strictObject({ title: z.string(), agents: z.int(), rounds: z.int(), listed: z.boolean() }),
});

export const OrderResponse = z.strictObject({ order: Order });
export const OrderListResponse = z.strictObject({ orders: z.array(Order) });

export const PaymentCheckRequest = z.strictObject({ txHash: Hash32 });

export const PaymentCheck = z.enum(["paid", "pending", "not_found", "failed", "no_payment", "mismatch"]);

export const PaymentCheckResponse = z.strictObject({
  order: Order,
  check: PaymentCheck,
  message: z.string(),
});

// ---------------------------------------------------------------------------------------------
// Runs: creation and status

/** A run paid from the wallet's prepaid balance. */
export const PrepaidRunRequest = z
  .strictObject({
    balance: z.literal(true),
    /** Yours to choose: a retry with the same id gets the first run back and pays nothing more. */
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    /** One agent of the crowd plays this wallet's clone. Such a run never reaches the gallery. */
    clone: z.literal(true).optional(),
    /** Play a past moment of a real pool again with one thing changed. Such a run stays out of the gallery too: it names a real token. */
    rewind: RewindInput.optional(),
    ...RunRequestFields,
  })
  .superRefine(checkRunRequest)
  .superRefine((request, ctx) => {
    if (request.clone && request.mix) ctx.addIssue({ code: "custom", path: ["mix"], message: "a run with a clone uses the default crowd" });
    if (request.clone && request.listed) ctx.addIssue({ code: "custom", path: ["listed"], message: "a run with a clone stays out of the gallery" });
    if (!request.rewind) return;
    if (request.listed) ctx.addIssue({ code: "custom", path: ["listed"], message: "a rewind stays out of the gallery" });
    if (request.scenario.events.length !== 1) ctx.addIssue({ code: "custom", path: ["scenario", "events"], message: "a rewind changes one thing: give exactly one event" });
    const market = request.scenario.market;
    if (market?.liquidityEth !== undefined || market?.liquidityTokens !== undefined) {
      ctx.addIssue({ code: "custom", path: ["scenario", "market"], message: "a rewind takes its liquidity from the chain" });
    }
  });

export const CreateRunRequest = z.union([
  z.strictObject({ orderId: Hash32 }),
  z.strictObject({ credit: z.literal(true), ...RunRequestFields }).superRefine(checkRunRequest),
  PrepaidRunRequest,
]);

export const JobState = z.enum(["queued", "running", "complete", "failed"]);

export const JobView = z.strictObject({
  status: JobState,
  attempt: z.int().nonnegative(),
  progress: z.strictObject({ round: z.int().min(0), rounds: z.int().min(1) }).nullable(),
  queuedAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  /** `credited`: the run was paid from a balance, and a failed one goes straight back to it. */
  refund: z.enum(["due", "sent", "credited"]).nullable(),
});

export const OracleState = z.enum(["pending", "sent", "confirmed", "failed"]);

export const OracleView = z.strictObject({
  status: OracleState,
  txHash: Hash32.nullable(),
  blockNumber: z.int().nullable(),
  chainId: z.int(),
  oracleAddress: Address,
});

/** `GET /v1/runs/:runId`: the published summary once there is one, the job while it runs. */
export const RunResponse = z.strictObject({
  run: RunSummary.nullable(),
  job: JobView.nullable(),
  oracle: OracleView.nullable(),
  /** Its question's outcome, once there is one. The question and the lean are in `run.question`. */
  outcome: z
    .strictObject({
      outcome: QuestionOutcome,
      note: z.string(),
      evidenceUrl: z.string().nullable(),
      decidedAt: Timestamp,
      txHash: Hash32.nullable(),
      status: z.enum(["pending", "sent", "confirmed", "failed"]),
    })
    .nullable()
    .optional(),
  disclaimer: Disclaimer,
});

export const CreateRunResponse = z.strictObject({ runId: RunId, job: JobView, chargedUsd: z.number().nonnegative().optional() });

// ---------------------------------------------------------------------------------------------
// API keys and prepaid balances

export const ApiKeyView = z.strictObject({
  id: z.string(),
  label: z.string().nullable(),
  /** The key's first characters, to tell keys apart. The key itself is shown once, when it is created. */
  prefix: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});

export const CreateKeyRequest = z.strictObject({ label: z.string().trim().min(1).max(60).optional() });
export const CreateKeyResponse = z.strictObject({ key: z.string().regex(/^hyvo_[A-Za-z0-9_-]{32,}$/), apiKey: ApiKeyView });
export const KeyListResponse = z.strictObject({ keys: z.array(ApiKeyView) });

export const BalanceReason = z.enum(["topup", "run", "run_failed", "ask", "ask_returned"]);

export const BalanceEntry = z.strictObject({
  id: z.string(),
  deltaUsd: z.number(),
  reason: BalanceReason,
  runId: RunId.nullable(),
  createdAt: Timestamp,
});

/** A balance is prepaid credit for runs: an accounting entry, with the funds in the treasury. It earns nothing. */
export const BalanceResponse = z.strictObject({
  address: Address,
  balanceUsd: z.number().nonnegative(),
  entries: z.array(BalanceEntry),
});

export const TopUpRequest = z.strictObject({
  amountUsd: z
    .number()
    .positive()
    .refine((usd) => Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-9, "must have at most two decimals"),
});

export const TopUp = z.strictObject({
  /** The PaymentRouter `orderId` (bytes32). */
  orderId: Hash32,
  status: OrderStatus,
  /** The wallet that gets the credit, whoever pays. */
  address: Address,
  token: PaymentToken,
  amount: z.string().regex(/^[0-9]+$/),
  amountUsd: z.number().positive(),
  creditedUsd: z.number().nonnegative().nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  paidAt: Timestamp.nullable(),
  chainId: z.int(),
  paymentRouter: Address,
});

export const TopUpResponse = z.strictObject({ topUp: TopUp });
export const TopUpCheckResponse = z.strictObject({ topUp: TopUp, check: PaymentCheck, message: z.string() });

// ---------------------------------------------------------------------------------------------
// Questions about a published run

export const AskRequest = z.strictObject({
  /** One agent of the run, or `report` to ask about the run as a whole. */
  agentId: z.union([AgentId, z.literal("report")]),
  question: z.string().trim().min(1).max(500),
});

export const AskResponse = z.strictObject({
  runId: RunId,
  agentId: z.string(),
  handle: z.string().nullable(),
  answer: z.string(),
  /** The answer broke the copy rules, so it was not sent and not charged. */
  withheld: z.boolean(),
  chargedUsd: z.number().nonnegative(),
  disclaimer: Disclaimer,
});

// ---------------------------------------------------------------------------------------------
// Webhooks

export const WebhookEventType = z.enum(["run.completed", "run.failed", "run.published", "oracle.committed", "question.resolved"]);

export const CreateWebhookRequest = z.strictObject({
  url: z.string().max(500),
  events: z.array(WebhookEventType).min(1),
});

export const WebhookView = z.strictObject({
  id: z.string(),
  url: z.string(),
  events: z.array(WebhookEventType),
  createdAt: Timestamp,
  /** Deleted, or switched off after too many failed deliveries in a row. */
  disabledAt: Timestamp.nullable(),
  failedInARow: z.int().nonnegative(),
});

export const CreateWebhookResponse = z.strictObject({
  webhook: WebhookView,
  /** Shown once. Check each delivery's `X-Hyvo-Signature` with it (docs/API.md). */
  secret: z.string().regex(/^whsec_[0-9a-f]{64}$/),
});

export const WebhookListResponse = z.strictObject({ webhooks: z.array(WebhookView) });

export const WebhookDeliveryView = z.strictObject({
  id: z.string(),
  type: WebhookEventType,
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.int().nonnegative(),
  nextAttemptAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  createdAt: Timestamp,
  deliveredAt: Timestamp.nullable(),
});

export const WebhookDeliveryListResponse = z.strictObject({ deliveries: z.array(WebhookDeliveryView) });

/** The body of a delivery. A repeat keeps its `id`. */
export const WebhookEvent = z.strictObject({
  id: z.string(),
  type: WebhookEventType,
  createdAt: Timestamp,
  data: z.strictObject({
    runId: RunId,
    hash: Hash32.optional(),
    title: z.string().optional(),
    status: RunStatus.optional(),
    reason: z.string().optional(),
    refund: z.enum(["due", "sent", "credited"]).nullable().optional(),
    txHash: Hash32.optional(),
    blockNumber: z.int().nullable().optional(),
    outcome: QuestionOutcome.optional(),
    result: CalibrationResult.optional(),
  }),
  disclaimer: Disclaimer,
});

// ---------------------------------------------------------------------------------------------
// Calibration: how often the crowd's lean matched what happened

export const CalibrationEntry = z.strictObject({
  runId: RunId,
  title: z.string(),
  question: z.string(),
  resolvesAt: Timestamp,
  expectation: CrowdExpectation,
  yes: z.int().nonnegative(),
  no: z.int().nonnegative(),
  unsure: z.int().nonnegative(),
  outcome: QuestionOutcome,
  result: CalibrationResult,
  note: z.string(),
  evidenceUrl: z.string().nullable(),
  decidedAt: Timestamp,
  /** The `resolve` transaction, once it is on-chain. */
  txHash: Hash32.nullable(),
  onChain: z.boolean(),
});

export const OpenQuestion = z.strictObject({
  runId: RunId,
  title: z.string(),
  question: z.string(),
  resolvesAt: Timestamp,
  expectation: CrowdExpectation,
  yes: z.int().nonnegative(),
  no: z.int().nonnegative(),
  unsure: z.int().nonnegative(),
  /** Its date has passed and no outcome is recorded yet. */
  overdue: z.boolean(),
});

export const CalibrationResponse = z.strictObject({
  counts: z.strictObject({
    hits: z.int().nonnegative(),
    misses: z.int().nonnegative(),
    noLean: z.int().nonnegative(),
    void: z.int().nonnegative(),
    open: z.int().nonnegative(),
  }),
  /** hits / (hits + misses); null before there is one of either. */
  hitRate: z.number().min(0).max(1).nullable(),
  /** By how firm the lean was: the larger side's share of yes + no. */
  buckets: z.array(z.strictObject({ label: z.string(), hits: z.int().nonnegative(), misses: z.int().nonnegative() })),
  resolved: z.array(CalibrationEntry),
  open: z.array(OpenQuestion),
  disclaimer: Disclaimer,
});

export const ResolveQuestionRequest = z.strictObject({
  outcome: QuestionOutcome,
  note: z.string().trim().min(1).max(500),
  evidenceUrl: z.url({ protocol: /^https?$/ }).max(300).optional(),
});

// ---------------------------------------------------------------------------------------------
// Oracle ledger

export const OracleEntry = z.strictObject({
  runId: RunId,
  runIdBytes32: Hash32,
  /** `reportHash` is the run hash (docs/RUN_FORMAT.md). */
  reportHash: Hash32,
  scenarioHash: Hash32,
  /** null for unlisted runs. */
  title: z.string().nullable(),
  status: OracleState,
  txHash: Hash32.nullable(),
  blockNumber: z.int().nullable(),
  committedAt: Timestamp.nullable(),
});

export const OracleLedgerResponse = z.strictObject({
  chainId: z.int(),
  oracleAddress: Address.nullable(),
  entries: z.array(OracleEntry),
  nextCursor: z.string().nullable(),
  disclaimer: Disclaimer,
});

export const OnChainCommit = z.strictObject({
  reportHash: Hash32,
  scenarioHash: Hash32,
  resolvesAt: z.int().nonnegative(),
  committedAt: z.int().nonnegative(),
  resolvedAt: z.int().nonnegative(),
  outcomeHash: Hash32,
});

export const OracleRunResponse = z.strictObject({
  entry: OracleEntry,
  chainId: z.int(),
  oracleAddress: Address.nullable(),
  /** Read from the chain by the API when it answered; verify it yourself (docs/API.md). */
  onChain: OnChainCommit.nullable(),
  matches: z.boolean().nullable(),
  disclaimer: Disclaimer,
});

// ---------------------------------------------------------------------------------------------
// Admin (founder wallets only)

export const RefundView = z.strictObject({
  id: z.string(),
  reason: z.string(),
  runId: RunId.nullable(),
  orderId: Hash32.nullable(),
  address: Address,
  token: Address,
  /** null for a token the API does not know: `amount` is then only meaningful in base units. */
  symbol: z.string().nullable(),
  decimals: z.int().nullable(),
  amount: z.string().regex(/^[0-9]+$/),
  status: z.enum(["due", "sent"]),
  txHash: Hash32.nullable(),
  note: z.string().nullable(),
  createdAt: Timestamp,
  sentAt: Timestamp.nullable(),
});

export const AdminOverviewResponse = z.strictObject({
  now: Timestamp,
  features: z.strictObject({ payments: z.boolean(), oracle: z.boolean(), holder: z.boolean(), clone: z.boolean() }),
  queue: z.strictObject({
    paused: z.boolean(),
    queued: z.int().nonnegative(),
    running: z.int().nonnegative(),
    spendTodayUsd: z.number().nonnegative(),
    dailyCapUsd: z.number().nonnegative(),
  }),
  fees: z.strictObject({
    todayUsd: z.number().nonnegative(),
    last30dUsd: z.number().nonnegative(),
    paymentsLast30d: z.int().nonnegative(),
  }),
  jobs: z.strictObject({
    completeLast7d: z.int().nonnegative(),
    partialLast7d: z.int().nonnegative(),
    failedLast7d: z.int().nonnegative(),
  }),
  failures: z.array(
    z.strictObject({
      runId: RunId,
      failedAt: Timestamp,
      reason: z.string(),
      refund: z.enum(["due", "sent"]).nullable(),
    }),
  ),
  refunds: z.array(RefundView),
  oracle: z.strictObject({
    pending: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    lastError: z.string().nullable(),
  }),
  /** Questions past their date, with no outcome yet. */
  questionsDue: z.array(OpenQuestion).optional(),
});

export const RefundSentRequest = z.strictObject({ txHash: Hash32, note: z.string().max(500).optional() });
export const QueueRequest = z.strictObject({ paused: z.boolean() });

export type RunSummary = z.infer<typeof RunSummary>;
export type RunListResponse = z.infer<typeof RunListResponse>;
export type FeaturedRunResponse = z.infer<typeof FeaturedRunResponse>;
export type RunResponse = z.infer<typeof RunResponse>;
export type ArtifactResponse = z.infer<typeof ArtifactResponse>;
export type PublishResponse = z.infer<typeof PublishResponse>;
export type ErrorResponse = z.infer<typeof ErrorResponse>;
export type HealthResponse = z.infer<typeof HealthResponse>;
export type RunMeta = z.infer<typeof RunMeta>;
export type PublishMeta = z.infer<typeof PublishMeta>;
export type NonceResponse = z.infer<typeof NonceResponse>;
export type SiweVerifyRequest = z.infer<typeof SiweVerifyRequest>;
export type SessionResponse = z.infer<typeof SessionResponse>;
export type HolderStatus = z.infer<typeof HolderStatus>;
export type MeResponse = z.infer<typeof MeResponse>;
export type QuoteRequest = z.infer<typeof QuoteRequest>;
export type PaymentToken = z.infer<typeof PaymentToken>;
export type OrderStatus = z.infer<typeof OrderStatus>;
export type Order = z.infer<typeof Order>;
export type OrderResponse = z.infer<typeof OrderResponse>;
export type OrderListResponse = z.infer<typeof OrderListResponse>;
export type PaymentCheck = z.infer<typeof PaymentCheck>;
export type PaymentCheckResponse = z.infer<typeof PaymentCheckResponse>;
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;
export type JobState = z.infer<typeof JobState>;
export type JobView = z.infer<typeof JobView>;
export type OracleState = z.infer<typeof OracleState>;
export type OracleView = z.infer<typeof OracleView>;
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;
export type QuestionOutcome = z.infer<typeof QuestionOutcome>;
export type CalibrationResult = z.infer<typeof CalibrationResult>;
export type CalibrationEntry = z.infer<typeof CalibrationEntry>;
export type OpenQuestion = z.infer<typeof OpenQuestion>;
export type CalibrationResponse = z.infer<typeof CalibrationResponse>;
export type ResolveQuestionRequest = z.infer<typeof ResolveQuestionRequest>;
export type WebhookEventType = z.infer<typeof WebhookEventType>;
export type WebhookView = z.infer<typeof WebhookView>;
export type CreateWebhookResponse = z.infer<typeof CreateWebhookResponse>;
export type WebhookListResponse = z.infer<typeof WebhookListResponse>;
export type WebhookDeliveryView = z.infer<typeof WebhookDeliveryView>;
export type WebhookDeliveryListResponse = z.infer<typeof WebhookDeliveryListResponse>;
export type WebhookEvent = z.infer<typeof WebhookEvent>;
export type AskRequest = z.infer<typeof AskRequest>;
export type AskResponse = z.infer<typeof AskResponse>;
export type ApiKeyView = z.infer<typeof ApiKeyView>;
export type CreateKeyResponse = z.infer<typeof CreateKeyResponse>;
export type KeyListResponse = z.infer<typeof KeyListResponse>;
export type BalanceReason = z.infer<typeof BalanceReason>;
export type BalanceEntry = z.infer<typeof BalanceEntry>;
export type BalanceResponse = z.infer<typeof BalanceResponse>;
export type TopUp = z.infer<typeof TopUp>;
export type TopUpResponse = z.infer<typeof TopUpResponse>;
export type TopUpCheckResponse = z.infer<typeof TopUpCheckResponse>;
export type OracleEntry = z.infer<typeof OracleEntry>;
export type OracleLedgerResponse = z.infer<typeof OracleLedgerResponse>;
export type OnChainCommit = z.infer<typeof OnChainCommit>;
export type OracleRunResponse = z.infer<typeof OracleRunResponse>;
export type RefundView = z.infer<typeof RefundView>;
export type AdminOverviewResponse = z.infer<typeof AdminOverviewResponse>;
