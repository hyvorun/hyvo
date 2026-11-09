import { shortenAddress } from "../chain/abi.js";
import type { BlockscoutContract } from "../chain/blockscout.js";
import type { SourcifyContract } from "../chain/sourcify.js";
import { makeFinding } from "../output/finding.js";
import type { Address, Finding } from "../types.js";
import { CHECKS } from "./catalog.js";

export type SourceLookup = {
  address: Address;
  /** Null when Sourcify could not be asked. */
  sourcify: SourcifyContract | null;
  /** Undefined when Blockscout was not asked (no key); null when it could not be asked. */
  blockscout?: BlockscoutContract | null;
};

function describe(l: SourceLookup): { verified: boolean | null; text: string } {
  const at = shortenAddress(l.address);
  if (l.sourcify && l.sourcify.match !== "none") {
    const kind =
      l.sourcify.match === "full"
        ? "a full match (source and metadata)"
        : "a partial match (the source matches, the metadata differs)";
    const when = l.sourcify.verifiedAt ? `, verified ${l.sourcify.verifiedAt.slice(0, 10)}` : "";
    return { verified: true, text: `Sourcify holds ${kind} for ${at} on chain 4663${when}` };
  }
  if (l.blockscout?.verified) return { verified: true, text: `Blockscout lists verified source for ${at}` };
  const parts: string[] = [];
  parts.push(l.sourcify ? `Sourcify has no verified source for ${at} on chain 4663` : `Sourcify could not be reached for ${at}`);
  if (l.blockscout === undefined) parts.push("Blockscout was not asked (no API key)");
  else if (l.blockscout === null) parts.push("Blockscout could not be reached");
  else parts.push("neither has Blockscout");
  const asked = l.sourcify !== null || (l.blockscout !== undefined && l.blockscout !== null);
  return { verified: asked ? false : null, text: parts.join("; ") };
}

/**
 * Verified source for the code that runs: the token itself, or for a proxy its implementation, with the
 * proxy's own status in the evidence too.
 */
export function verifiedCheck(token: SourceLookup, implementation?: SourceLookup): Finding {
  const title = CHECKS.source.title;
  const own = describe(token);
  if (!implementation) {
    if (own.verified === null) return makeFinding({ id: "source", title, status: "skipped", evidence: own.text });
    return makeFinding({ id: "source", title, status: own.verified ? "found" : "not_found", evidence: own.text });
  }
  const impl = describe(implementation);
  const evidence = `implementation: ${impl.text}; proxy: ${own.text}`;
  if (impl.verified === null) return makeFinding({ id: "source", title, status: "skipped", evidence });
  return makeFinding({ id: "source", title, status: impl.verified ? "found" : "not_found", evidence });
}
