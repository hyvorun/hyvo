// Turns revert data into a short, readable reason for evidence: Error(string), Panic(uint256), a few custom
// errors seen on Robinhood Chain's venues, and V4's WrappedError around a hook's own revert. Text inside a revert
// comes from the contract's author, so it is quoted through quoteThirdParty.

import { quoteThirdParty } from "../output/copy.js";
import { funcSelector, shortenAddress, strip0x } from "./abi.js";
import { decodeParameters } from "./abi-decode.js";

const PANICS: Record<number, string> = {
  0x01: "assert failed",
  0x11: "arithmetic overflow or underflow",
  0x12: "division by zero",
  0x21: "invalid enum value",
  0x22: "invalid storage byte array",
  0x31: "pop on an empty array",
  0x32: "array index out of bounds",
  0x41: "out of memory",
  0x51: "call to an uninitialized function",
};

// Custom errors seen on the venues Hyvo Check trades through (Uniswap V4, Pons) and common token errors
// (OpenZeppelin 5). Arguments are shown only when they are plain values.
const KNOWN_ERRORS = [
  "CurrencyNotSettled()",
  "ManagerLocked()",
  "PoolNotInitialized()",
  "PriceLimitAlreadyExceeded(uint160,uint160)",
  "CurveGraduated()",
  "SlippageExceeded(uint256,uint256)",
  "TransferFailed()",
  "ZeroAmount()",
  "ERC20InsufficientBalance(address,uint256,uint256)",
  "ERC20InsufficientAllowance(address,uint256,uint256)",
  "ERC20InvalidSender(address)",
  "ERC20InvalidReceiver(address)",
  "EnforcedPause()",
  "OwnableUnauthorizedAccount(address)",
];

const WRAPPED_ERROR = "WrappedError(address,bytes4,bytes,bytes)";
const ERROR_STRING = "0x08c379a0";
const PANIC = "0x4e487b71";

let known: Map<string, { name: string; types: string[] }> | null = null;

function knownErrors(): Map<string, { name: string; types: string[] }> {
  if (known) return known;
  known = new Map();
  for (const sig of KNOWN_ERRORS) {
    const m = /^(\w+)\((.*)\)$/.exec(sig)!;
    known.set(funcSelector(sig), { name: m[1]!, types: m[2] ? m[2].split(",") : [] });
  }
  return known;
}

function formatArg(type: string, value: unknown): string {
  if (type === "address" && typeof value === "string") return shortenAddress(value);
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

/** A readable reason for revert data; "no reason given" when the revert carried no data. */
export function decodeRevert(data: string | null | undefined, depth = 0): string {
  const clean = strip0x(data ?? "").toLowerCase();
  if (clean.length < 8) return "no reason given";
  const selector = `0x${clean.slice(0, 8)}`;
  const args = `0x${clean.slice(8)}`;
  try {
    if (selector === ERROR_STRING) {
      const [message] = decodeParameters([{ type: "string" }], args) as [string];
      return `Error("${quoteThirdParty(message)}")`;
    }
    if (selector === PANIC) {
      const [code] = decodeParameters([{ type: "uint256" }], args) as [bigint];
      const meaning = PANICS[Number(code)] ?? "unknown panic code";
      return `Panic(0x${code.toString(16)}: ${meaning})`;
    }
    if (selector === funcSelector(WRAPPED_ERROR) && depth < 3) {
      const [target, inner, reason] = decodeParameters(
        [{ type: "address" }, { type: "bytes4" }, { type: "bytes" }, { type: "bytes" }],
        args,
      ) as [string, string, string, string];
      return `WrappedError(${shortenAddress(target)}, ${inner}: ${decodeRevert(reason, depth + 1)})`;
    }
    const err = knownErrors().get(selector);
    if (err) {
      if (err.types.length === 0) return `${err.name}()`;
      const values = decodeParameters(
        err.types.map((type) => ({ type })),
        args,
      );
      return `${err.name}(${values.map((v, i) => formatArg(err.types[i]!, v)).join(", ")})`;
    }
  } catch {
    // Malformed arguments: fall through to the bare selector.
  }
  return `custom error ${selector}`;
}
