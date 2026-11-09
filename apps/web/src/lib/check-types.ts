/**
 * Hyvo Check's types: what a token does when someone buys it, sends it on and sells it, measured at one block,
 * and the facts beside it, each with its evidence. They live in @hyvo/check (packages/check), which measures;
 * the /check page shows them. Re-exported here so web code keeps one import path.
 *
 * Amounts are raw integers (bigint) in the token's or ETH's smallest unit; `serializeReport` turns them into
 * decimal strings for JSON.
 */
export type {
  Address,
  CheckErrorCode,
  CheckId,
  CheckOptions,
  CheckReport,
  CodeFacts,
  ExitSimulation,
  Finding,
  FindingStatus,
  Hex,
  JsonCheckReport,
  Step,
  Timings,
  TokenInfo,
  Venue,
} from "@hyvo/check";
export { CHECK_NOTICE, CHECKS, CheckError, serializeReport } from "@hyvo/check";
