import { SELECTORS, ZERO_ADDRESS, decodeAddress, shortenAddress, strip0x } from "../chain/abi.js";
import type { Read } from "../chain/multicall.js";
import { makeFinding } from "../output/finding.js";
import type { Finding } from "../types.js";
import { CHECKS } from "./catalog.js";
import type { OwnerState } from "./context.js";

export function ownerReads(token: string): Read[] {
  return [
    { target: token, data: SELECTORS.owner },
    { target: token, data: SELECTORS.getOwner },
  ];
}

/** owner() is preferred when both answer. A revert or an empty answer from both means there is no owner function. */
export function parseOwner(ownerRaw: string | null, getOwnerRaw: string | null): OwnerState {
  const word = (raw: string | null): string | null => (raw && strip0x(raw).length >= 64 ? raw : null);
  const fromOwner = word(ownerRaw);
  const fromGetOwner = word(getOwnerRaw);
  const raw = fromOwner ?? fromGetOwner;
  if (raw === null) return { state: "none", address: null, via: null };
  const via = fromOwner ? "owner()" : "getOwner()";
  const address = decodeAddress(raw);
  if (address === ZERO_ADDRESS) return { state: "renounced", address, via };
  return { state: "active", address, via };
}

export function ownershipCheck(owner: OwnerState, reason?: string): Finding {
  const title = CHECKS.owner.title;
  if (owner.state === "active" && owner.address) {
    return makeFinding({ id: "owner", title, status: "found", evidence: `${owner.via} returns ${shortenAddress(owner.address)}` });
  }
  if (owner.state === "renounced") {
    return makeFinding({ id: "owner", title, status: "not_found", evidence: `${owner.via} returns the zero address` });
  }
  if (owner.state === "none") {
    return makeFinding({ id: "owner", title, status: "not_found", evidence: "neither owner() nor getOwner() answers" });
  }
  return makeFinding({ id: "owner", title, status: "skipped", evidence: `owner() could not be read: ${reason ?? "the RPC failed"}` });
}
