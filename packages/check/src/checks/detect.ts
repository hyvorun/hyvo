import { funcSelector, shortenAddress, strip0x } from "../chain/abi.js";
import type { AbiItem } from "../chain/sourcify.js";
import { makeFinding } from "../output/finding.js";
import type { CheckId, Finding } from "../types.js";
import { CHECKS } from "./catalog.js";
import type { CheckContext, CodeTarget, OwnerState } from "./context.js";

export type DetectedFn = {
  label: string; // canonical signature, e.g. 'setFee(uint256)'
  selector: string; // '0x...'
};

export type FunctionCategory = {
  /** Signatures looked for in unverified bytecode. */
  signatures: readonly string[];
  /** Function names matched in a verified ABI (state-changing functions only). */
  abiName: RegExp;
  /** Optional extra condition on a matched ABI function's inputs. */
  inputs?: (inputs: readonly { type: string }[]) => boolean;
  /** How the matched names read in "not found" evidence, e.g. "mint, mintTo or increaseSupply". */
  describe: string;
};

/**
 * Detects whether a contract exposes functions in a category.
 *
 * - Verified contract: read the ABI (authoritative). Match function names against `abiName`, skipping view and
 *   pure functions (a getter such as minter() or paused() is not a power), and derive signature and selector.
 * - Unverified contract: compute the selectors of `signatures` and look for the dispatcher pattern
 *   PUSH4 <selector> (0x63 + selector; PUSH3 or PUSH2 when the selector starts with zero bytes) in the
 *   bytecode. This is a heuristic: a selector in the dispatcher means the function is reachable even when the
 *   source is hidden, and a function under a name not in the list is not found.
 */
export function detectFunctions(code: CodeTarget, category: FunctionCategory): { found: DetectedFn[]; method: "abi" | "bytecode" } {
  const found = new Map<string, DetectedFn>();

  if (code.abi) {
    for (const item of code.abi as AbiItem[]) {
      if (item.type !== "function" || !item.name) continue;
      if (item.stateMutability === "view" || item.stateMutability === "pure") continue;
      if (!category.abiName.test(item.name)) continue;
      const inputs = item.inputs ?? [];
      if (category.inputs && !category.inputs(inputs)) continue;
      const sig = `${item.name}(${inputs.map((i) => i.type).join(",")})`;
      const selector = funcSelector(sig);
      found.set(selector, { label: sig, selector });
    }
    return { found: [...found.values()], method: "abi" };
  }

  const bytecode = strip0x(code.bytecode).toLowerCase();
  for (const sig of category.signatures) {
    const selector = funcSelector(sig);
    if (dispatcherHas(bytecode, strip0x(selector))) found.set(selector, { label: sig, selector });
  }
  return { found: [...found.values()], method: "bytecode" };
}

function dispatcherHas(bytecode: string, selector: string): boolean {
  if (bytecode.includes(`63${selector}`)) return true;
  // solc pushes a selector with leading zero bytes with a shorter PUSH.
  if (selector.startsWith("0000")) return bytecode.includes(`61${selector.slice(4)}`);
  if (selector.startsWith("00")) return bytecode.includes(`62${selector.slice(2)}`);
  return false;
}

/**
 * Who could call it, stated as facts only. Access control is not resolved here, so the evidence never claims
 * that the owner can call the function.
 */
export function ownerEvidence(owner: OwnerState): string {
  if (owner.state === "active" && owner.address) return `${owner.via ?? "owner()"} returns ${shortenAddress(owner.address)}`;
  if (owner.state === "renounced") return `${owner.via ?? "owner()"} returns the zero address`;
  if (owner.state === "none") return "neither owner() nor getOwner() answers";
  return "the owner could not be read";
}

function where(code: CodeTarget): string {
  return code.via === "token" ? "" : ` of the implementation ${shortenAddress(code.address)}`;
}

/** One finding for a category of owner-style powers: found with the functions, or not found with where it looked. */
export function powerFinding(id: CheckId, ctx: CheckContext, category: FunctionCategory): Finding {
  const title = CHECKS[id].title;
  if (!ctx.code) {
    return makeFinding({ id, title, status: "skipped", evidence: ctx.codeMissing ?? "the contract's code could not be read" });
  }
  const { found, method } = detectFunctions(ctx.code, category);
  const source = method === "abi" ? `the verified ABI${where(ctx.code)} (${ctx.code.abiSource})` : `the bytecode's dispatcher${where(ctx.code)}`;
  if (found.length > 0) {
    const list = found.map((f) => `${f.label} (${f.selector})`).join(", ");
    return makeFinding({ id, title, status: "found", evidence: `${list} in ${source}; ${ownerEvidence(ctx.owner)}` });
  }
  const looked =
    method === "abi"
      ? `${source} has no state-changing function named ${category.describe}`
      : `none of ${category.signatures.join(", ")} in ${source}`;
  return makeFinding({ id, title, status: "not_found", evidence: looked });
}
