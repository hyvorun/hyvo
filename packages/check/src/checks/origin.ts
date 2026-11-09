import { shortenAddress } from "../chain/abi.js";
import type { SourcifyContract } from "../chain/sourcify.js";
import { makeFinding } from "../output/finding.js";
import type { Launchpad } from "../registry/launchpads.js";
import type { Address, Finding } from "../types.js";
import { CHECKS } from "./catalog.js";

export type OriginInput = {
  /** The launchpad whose record holds the token, and who launched it there; null when none does. */
  launch: { launchpad: Launchpad; launcher: Address } | null;
  /** Sourcify's deployment record; undefined when Sourcify could not be asked, null when it has none. */
  sourcify: SourcifyContract["deployment"] | undefined;
  /** Blockscout's creator; undefined when Blockscout was not asked (no key), null when it did not answer. */
  blockscout: { deployer: Address; creationTxHash: string | null } | null | undefined;
};

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

/** Who created or launched the token. A wrong attribution is worse than none, so every source is named. */
export function originCheck(input: OriginInput): Finding {
  const title = CHECKS.deployer.title;
  if (input.launch) {
    const { launchpad, launcher } = input.launch;
    return makeFinding({
      id: "deployer",
      title,
      status: "found",
      evidence: `launched by ${shortenAddress(launcher)} through ${launchpad.name}: getLaunchedToken on its factory ${shortenAddress(launchpad.factory)} records it`,
    });
  }
  if (input.sourcify) {
    const d = input.sourcify;
    return makeFinding({
      id: "deployer",
      title,
      status: "found",
      evidence: `created by ${shortenAddress(d.deployer)} in transaction ${shortHash(d.transactionHash)} at block ${d.blockNumber.toLocaleString("en-US")} (Sourcify); no Pons launch record`,
    });
  }
  if (input.blockscout) {
    const tx = input.blockscout.creationTxHash ? ` in transaction ${shortHash(input.blockscout.creationTxHash)}` : "";
    return makeFinding({
      id: "deployer",
      title,
      status: "found",
      evidence: `created by ${shortenAddress(input.blockscout.deployer)}${tx} (Blockscout); no Pons launch record`,
    });
  }
  const sourcify = input.sourcify === undefined ? "Sourcify could not be reached" : "Sourcify has no deployment record";
  const blockscout =
    input.blockscout === undefined ? "no Blockscout key was given" : "Blockscout did not name a creator";
  return makeFinding({
    id: "deployer",
    title,
    status: "skipped",
    evidence: `the creator is unknown here: no Pons launch record, ${sourcify}, and ${blockscout}`,
  });
}
