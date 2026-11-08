/**
 * dApp Dry Run (SPEC 11.1): what a developer submits, what the API says about it, and `dryrun.json`, the report. The engine writes
 * that file (engine/hyvo/dryrun/document.py) and hashes it like a run: RFC 8785, then keccak-256, without its `hash` field.
 */
import { z } from "zod";
import { Address, DISCLAIMER, Hash32, RunId, Timestamp } from "./run";

export const MAX_DRYRUN_BYTECODE_CHARS = 2 + 2 * 49_152;
export const DRYRUN_LIMITS = { minAgents: 4, maxAgents: 40, minRounds: 1, maxRounds: 30 } as const;

const AbiEntry = z.looseObject({ type: z.string() });

export const DryRunRequest = z
  .strictObject({
    balance: z.literal(true),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    description: z.string().trim().min(1).max(2000),
    /** A contract on Robinhood Chain, played on a fork. Its ABI comes from Sourcify when it is not given. */
    address: Address.optional(),
    /** Or creation code, played on a plain chain. It needs its ABI. */
    bytecode: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(MAX_DRYRUN_BYTECODE_CHARS).optional(),
    abi: z.array(AbiEntry).max(300).optional(),
    constructorArgs: z.array(z.unknown()).max(16).optional(),
    /** View functions without arguments that must stay true. */
    invariants: z.array(z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)).max(10).optional(),
    agents: z.int().min(DRYRUN_LIMITS.minAgents).max(DRYRUN_LIMITS.maxAgents).default(12),
    rounds: z.int().min(DRYRUN_LIMITS.minRounds).max(DRYRUN_LIMITS.maxRounds).default(8),
  })
  .superRefine((request, ctx) => {
    if ((request.address === undefined) === (request.bytecode === undefined)) {
      ctx.addIssue({ code: "custom", path: ["address"], message: "give either a contract address or bytecode" });
    }
    if (request.bytecode !== undefined && request.abi === undefined) {
      ctx.addIssue({ code: "custom", path: ["abi"], message: "bytecode needs its ABI" });
    }
    if (request.address !== undefined && request.constructorArgs !== undefined) {
      ctx.addIssue({ code: "custom", path: ["constructorArgs"], message: "a deployed contract has no constructor to call" });
    }
  });

export const DryRunSummary = z.strictObject({
  status: z.enum(["complete", "partial"]),
  findings: z.strictObject({
    high: z.int().nonnegative(),
    medium: z.int().nonnegative(),
    low: z.int().nonnegative(),
    info: z.int().nonnegative(),
  }),
  calls: z.int().nonnegative(),
  reverted: z.int().nonnegative(),
});

/** What the runner reports when it delivers a report. */
export const DryRunMeta = z.strictObject({
  hash: Hash32,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  summary: DryRunSummary,
  usage: z.strictObject({ costUsd: z.number().nonnegative(), llmCalls: z.int().nonnegative() }),
});

const Refund = z.enum(["credited"]).nullable();

export const DryRunView = z.strictObject({
  runId: RunId,
  title: z.string(),
  status: z.enum(["queued", "running", "complete", "failed"]),
  progress: z.strictObject({ round: z.int().min(0), rounds: z.int().min(1) }).nullable(),
  queuedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  chargedUsd: z.number().nonnegative(),
  hash: Hash32.nullable(),
  summary: DryRunSummary.nullable(),
  /** Why it failed, when it did. What it cost has gone back to the balance. */
  failReason: z.string().nullable(),
  refund: Refund,
});

export const DryRunResponse = z.strictObject({ dryRun: DryRunView, disclaimer: z.string() });
export const DryRunListResponse = z.strictObject({ dryRuns: z.array(DryRunView), disclaimer: z.string() });

// ---------------------------------------------------------------------------------------------
// The report

export const FindingKind = z.enum([
  "invariant_violation",
  "invariant_unreadable",
  "access_control",
  "unusual_balance",
  "confusing_flow",
  "gas_outlier",
  "never_worked",
]);

const Step = z.strictObject({
  round: z.int().nonnegative(),
  agentId: z.string(),
  function: z.string(),
  args: z.array(z.unknown()),
  valueWei: z.string(),
});

export const Finding = z.strictObject({
  severity: z.enum(["high", "medium", "low", "info"]),
  kind: FindingKind,
  title: z.string(),
  detail: z.string(),
  /** The calls that lead to it, in order. */
  reproduce: z.array(Step),
});

export const DryRunCall = z.strictObject({
  round: z.int().min(1),
  agentId: z.string(),
  persona: z.string(),
  function: z.string(),
  args: z.array(z.unknown()),
  valueWei: z.string(),
  status: z.enum(["ok", "reverted", "invalid"]),
  reason: z.string().nullable(),
  gasUsed: z.int().nonnegative().nullable(),
  txHash: z.string().nullable(),
  ethDeltaWei: z.string(),
  contractDeltaWei: z.string(),
  events: z.array(z.string()),
  changes: z.record(z.string(), z.array(z.string().nullable())),
  feedback: z.string(),
});

export const DryRunReport = z.strictObject({
  runId: RunId,
  kind: z.literal("dryrun"),
  version: z.literal(1),
  createdAt: Timestamp,
  status: z.enum(["complete", "partial"]),
  stopReason: z.string().nullable(),
  description: z.string(),
  target: z.strictObject({ kind: z.enum(["address", "bytecode"]), address: Address, forked: z.boolean() }),
  crowd: z.strictObject({
    size: z.int().min(1),
    personas: z.record(z.string(), z.int().nonnegative()),
    agents: z.array(z.strictObject({ agentId: z.string(), persona: z.string(), address: Address, startWei: z.string(), endWei: z.string() })),
    model: z.string(),
  }),
  actionSpace: z.strictObject({ functions: z.array(z.string()), keptForTheOwner: z.array(z.string()), reads: z.array(z.string()) }),
  rounds: z.array(z.strictObject({ n: z.int().min(1), state: z.record(z.string(), z.string()), firstCall: z.int().nonnegative(), calls: z.int().nonnegative() })),
  calls: z.array(DryRunCall),
  invariants: z.array(
    z.strictObject({ name: z.string(), held: z.boolean(), firstBroken: z.int().nullable(), falseFromStart: z.boolean(), error: z.string().nullable() }),
  ),
  probes: z.array(
    z.strictObject({ agentId: z.string(), function: z.string(), args: z.array(z.unknown()), status: z.string(), reason: z.string().nullable(), tookWei: z.string() }),
  ),
  findings: z.array(Finding),
  feedback: z.array(z.strictObject({ agentId: z.string(), persona: z.string(), round: z.int().min(1), text: z.string() })),
  finalState: z.strictObject({ contractWei: z.string(), reads: z.record(z.string(), z.string()) }),
  usage: z.looseObject({ llmCalls: z.int().nonnegative(), costUsd: z.number().nonnegative() }),
  disclaimer: z.string().refine((text) => text.includes(DISCLAIMER), "must carry the disclaimer"),
  hash: Hash32,
});

export type DryRunRequest = z.input<typeof DryRunRequest>;
export type DryRunSummary = z.infer<typeof DryRunSummary>;
export type DryRunMeta = z.infer<typeof DryRunMeta>;
export type DryRunView = z.infer<typeof DryRunView>;
export type DryRunResponse = z.infer<typeof DryRunResponse>;
export type DryRunListResponse = z.infer<typeof DryRunListResponse>;
export type Finding = z.infer<typeof Finding>;
export type DryRunCall = z.infer<typeof DryRunCall>;
export type DryRunReport = z.infer<typeof DryRunReport>;
