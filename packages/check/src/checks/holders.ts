import { sameAddress, shortenAddress } from "../chain/abi.js";
import { formatPct } from "../chain/units.js";
import { makeFinding } from "../output/finding.js";
import type { Address, Finding } from "../types.js";
import { CHECKS } from "./catalog.js";

export type HoldersInput = {
  /** False when no Blockscout key was given, so Blockscout was not asked. */
  asked: boolean;
  totalSupply: bigint | null;
  holderCount: number | null;
  /** Blockscout's first page of holders, largest first; null when it did not answer. */
  holders: { address: Address; value: bigint }[] | null;
  /** Who created or launched the token, when known; its share is read from the same holder list. */
  deployer: Address | null;
  /** Addresses that hold tokens for others or for nobody: burn addresses, the PoolManager, the venue's pool. */
  excluded: { address: Address; label: string }[];
  /**
   * Where the holders were read when they did not come from Blockscout with the caller's own key, such as
   * "Blockscout's index, read through Hyvo's API at 07:12 UTC on 2026-11-09". The evidence names it, and says
   * the balances were not read at `block`.
   */
  source?: string;
  /** Why `holders` is null, in plain words, when the source said. */
  missing?: string | null;
  /** The block the check read at. */
  block?: bigint;
};

// Percentage with two decimals, computed in bigint.
function pct(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Number((part * 10000n) / whole) / 100;
}

/**
 * How much of the supply the ten largest holders hold. Burn addresses, the Uniswap V4 PoolManager (which holds
 * pool liquidity, not a holder's tokens) and the venue's own pool are left out, and the evidence says so.
 */
export function holdersCheck(input: HoldersInput): Finding {
  const title = CHECKS.holders.title;
  if (!input.asked) {
    return makeFinding({
      id: "holders",
      title,
      status: "skipped",
      evidence:
        "needs a Blockscout API key, and none was given: the explorer refuses programs, and its API answers only with a key",
    });
  }
  const { totalSupply, holders } = input;
  if (!holders || totalSupply === null || totalSupply === 0n) {
    const why = !holders
      ? (input.missing ?? "Blockscout did not return the token's holders")
      : "the token's total supply is unknown or zero, so no share of it can be given";
    return makeFinding({ id: "holders", title, status: "skipped", evidence: input.source && holders ? `${why} (${input.source})` : why });
  }

  const ranked = holders
    .filter((h) => !input.excluded.some((e) => sameAddress(e.address, h.address)))
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const top = ranked.slice(0, 10);
  const share = pct(
    top.reduce((s, h) => s + h.value, 0n),
    totalSupply,
  );
  const labels = [...new Set(input.excluded.map((e) => e.label))];
  const parts = [
    `the ${top.length} largest holders hold ${formatPct(share)} of the supply, leaving out ${labels.join(", ")}`,
  ];
  if (input.holderCount !== null) parts.push(`${input.holderCount.toLocaleString("en-US")} holders in all (Blockscout)`);
  if (input.deployer) {
    const listed = holders.find((h) => sameAddress(h.address, input.deployer));
    parts.push(
      listed
        ? `the deployer ${shortenAddress(input.deployer)} holds ${formatPct(pct(listed.value, totalSupply))}`
        : `the deployer ${shortenAddress(input.deployer)} is not among the ${holders.length} largest holders Blockscout listed`,
    );
  }
  if (input.source) {
    const block = input.block !== undefined ? `, not read at block ${input.block.toLocaleString("en-US")}` : "";
    parts.push(`balances from ${input.source}${block}`);
  }
  return makeFinding({ id: "holders", title, status: "found", evidence: parts.join("; ") });
}
