import { decodeAddress, shortenAddress, strip0x, toChecksumAddress } from "../chain/abi.js";
import { makeFinding } from "../output/finding.js";
import type { Address, Finding } from "../types.js";
import { CHECKS } from "./catalog.js";
import type { DetectedFn, FunctionCategory } from "./detect.js";

/** The functions an upgradeable proxy's code uses to point the proxy at new code (UUPS, ERC-1967). */
export const UPGRADE: FunctionCategory = {
  signatures: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"],
  abiName: /^upgradeTo(AndCall)?$/,
  describe: "upgradeTo or upgradeToAndCall",
};

// EIP-1967 standard storage slots.
export const SLOT_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

// EIP-1167 minimal proxy bytecode: prefix + 20-byte implementation + suffix.
const CLONE_PREFIX = "363d3d373d3d3d363d73";
const CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

export type ProxyInfo =
  | { kind: "eip1167"; implementation: Address }
  | { kind: "eip1967"; implementation: Address }
  | { kind: "beacon"; beacon: Address; implementation: Address | null }
  | { kind: "none" };

/** The fixed implementation of an EIP-1167 clone, read straight from its bytecode; null for other code. */
export function cloneTarget(bytecode: string): Address | null {
  const code = strip0x(bytecode).toLowerCase();
  if (!code.startsWith(CLONE_PREFIX) || !code.includes(CLONE_SUFFIX)) return null;
  return toChecksumAddress(`0x${code.slice(CLONE_PREFIX.length, CLONE_PREFIX.length + 40)}`);
}

export function isNonZeroSlot(raw: string): boolean {
  const clean = strip0x(raw).toLowerCase();
  return clean.length > 0 && /[1-9a-f]/.test(clean);
}

/** What the bytecode and the two EIP-1967 slots say, before a beacon's implementation() is asked. */
export function readProxy(bytecode: string, implSlot: string, beaconSlot: string): ProxyInfo {
  const clone = cloneTarget(bytecode);
  if (clone) return { kind: "eip1167", implementation: clone };
  if (isNonZeroSlot(implSlot)) return { kind: "eip1967", implementation: decodeAddress(implSlot) };
  if (isNonZeroSlot(beaconSlot)) return { kind: "beacon", beacon: decodeAddress(beaconSlot), implementation: null };
  return { kind: "none" };
}

/**
 * `upgrade`: the upgrade functions found in the implementation's code, with where they were found, when the code
 * could be read.
 */
export function proxyCheck(
  info: ProxyInfo | null,
  failure?: string,
  upgrade?: { found: DetectedFn[]; method: "abi" | "bytecode" },
): Finding {
  const upgradeNote =
    upgrade && upgrade.found.length > 0
      ? `; the implementation has ${upgrade.found.map((f) => `${f.label} (${f.selector})`).join(", ")} in its ${
          upgrade.method === "abi" ? "verified ABI" : "bytecode's dispatcher"
        }`
      : "";
  const title = CHECKS.proxy.title;
  if (info === null) {
    return makeFinding({
      id: "proxy",
      title,
      status: "skipped",
      evidence: `the proxy slots could not be read: ${failure ?? "the RPC failed"}`,
    });
  }
  switch (info.kind) {
    case "eip1167":
      return makeFinding({
        id: "proxy",
        title,
        status: "found",
        evidence: `an EIP-1167 minimal proxy: every call runs the code of ${shortenAddress(info.implementation)}, fixed when the clone was created`,
      });
    case "eip1967":
      return makeFinding({
        id: "proxy",
        title,
        status: "found",
        evidence: `the EIP-1967 implementation slot holds ${shortenAddress(info.implementation)}, so the token runs that contract's code; whoever can upgrade the proxy can change it${upgradeNote}`,
      });
    case "beacon":
      return makeFinding({
        id: "proxy",
        title,
        status: "found",
        evidence: info.implementation
          ? `the EIP-1967 beacon slot holds ${shortenAddress(info.beacon)}, whose implementation() returns ${shortenAddress(info.implementation)}${upgradeNote}`
          : `the EIP-1967 beacon slot holds ${shortenAddress(info.beacon)}, whose implementation() does not answer`,
      });
    case "none":
      return makeFinding({
        id: "proxy",
        title,
        status: "not_found",
        evidence: "the EIP-1967 implementation and beacon slots are empty, and the code is not an EIP-1167 clone",
      });
  }
}
