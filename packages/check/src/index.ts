/**
 * Hyvo Check: read-only facts about a Robinhood Chain token, each with its evidence, and an exit simulation
 * that buys, sends and sells the token inside one eth_call. Nothing is signed, approved or sent.
 *
 * Runs unchanged in browsers, Node 18+ and Cloudflare Workers: no runtime dependencies, no Node modules.
 */

export { checkToken, CHECK_NOTICE } from "./check.js";
export { CHECKS, CHECK_ORDER } from "./checks/catalog.js";
export { SHORTFALL_TOLERANCE_PCT } from "./checks/sell-simulation.js";
export { ADDRESSES, PROBE_ADDRESS, PROBE_CALLER, type KnownContract } from "./registry/addresses.js";
export { LAUNCHPADS, type Launchpad } from "./registry/launchpads.js";
export { ROBINHOOD_CHAIN, DEFAULT_ETH_IN } from "./chain/config.js";
export { formatAmount, formatEth, formatUnits, formatPct, parseEth } from "./chain/units.js";
export { isAddress, toChecksumAddress, shortenAddress } from "./chain/abi.js";
export { serializeReport, type JsonCheckReport, type Jsonified } from "./output/serialize.js";
export { PROBE_RUNTIME, PROBE_SOURCE_SHA256 } from "./probe/index.js";
export {
  CheckError,
  type Address,
  type CheckErrorCode,
  type CheckId,
  type CheckOptions,
  type CheckReport,
  type CodeFacts,
  type ExitSimulation,
  type FetchLike,
  type Finding,
  type FindingStatus,
  type Hex,
  type Step,
  type Timings,
  type TokenInfo,
  type Venue,
} from "./types.js";
