/**
 * Verify a run against its oracle commit in the browser (docs/API.md, "Verifying a run"):
 *
 * 1. download run.json through its signed link and re-hash it (RFC 8785 + keccak256);
 * 2. read `HyvoOracle.getCommit(runIdBytes32)` from Robinhood Chain;
 * 3. the commit's reportHash must equal the run hash, and its scenarioHash the hash of
 *    `run.scenario`.
 *
 * The API is used only to find the artifact link and the oracle address; the hashes and the
 * chain read are done here.
 */
import { hashRun, runIdToBytes32, scenarioHash, type RunV1 } from "@hyvo/schema";
import { isAddress, type Address, type Hex } from "viem";
import { fetchRunDocument } from "./api";
import { ORACLE_ABI, publicClient } from "./chain";

export interface CommitRead {
  reportHash: Hex;
  scenarioHash: Hex;
  committedAt: bigint;
}

export type Step = { label: string; ok: boolean; detail: string };

export interface Verification {
  ok: boolean;
  runHash: Hex | null;
  steps: Step[];
}

export type ReadCommit = (oracle: Address, runIdBytes32: Hex) => Promise<CommitRead | null>;

export async function readCommitFromChain(oracle: Address, runIdBytes32: Hex): Promise<CommitRead | null> {
  const commit = await publicClient().readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: "getCommit",
    args: [runIdBytes32],
  });
  return commit.committedAt === 0n ? null : commit;
}

export interface OracleSource {
  address: Address | null;
  /** The address comes from this build, not from the API. */
  pinned: boolean;
  /** The API names another contract than the one this build pins. */
  conflict: Address | null;
}

/**
 * Which contract to check against. A verification that took the address from the API would trust
 * the API: it could point at a contract of its own that agrees with anything.
 */
export function resolveOracle(pinned: string, fromApi: string | null): OracleSource {
  if (isAddress(pinned, { strict: false })) {
    const conflict = fromApi && fromApi.toLowerCase() !== pinned.toLowerCase() ? (fromApi as Address) : null;
    return { address: pinned as Address, pinned: true, conflict };
  }
  return { address: fromApi as Address | null, pinned: false, conflict: null };
}

/** The checks for an already loaded run.json and an on-chain read (pure, for tests). */
export function compare(run: RunV1, commit: CommitRead | null): Verification {
  const computed = hashRun(run);
  const scenario = scenarioHash(run.scenario);
  const steps: Step[] = [
    {
      label: "run.json re-hashed in this browser",
      ok: computed === run.hash,
      detail: computed === run.hash ? computed : `computed ${computed}, the file says ${run.hash}`,
    },
  ];
  if (!commit) {
    steps.push({ label: "HyvoOracle commit on Robinhood Chain", ok: false, detail: "no commit for this run id" });
    return { ok: false, runHash: computed, steps };
  }
  steps.push(
    {
      label: "reportHash on chain = run hash",
      ok: commit.reportHash.toLowerCase() === computed,
      detail: commit.reportHash.toLowerCase(),
    },
    {
      label: "scenarioHash on chain = hash of the scenario",
      ok: commit.scenarioHash.toLowerCase() === scenario,
      detail: commit.scenarioHash.toLowerCase(),
    },
  );
  return { ok: steps.every((step) => step.ok), runHash: computed, steps };
}

export async function verifyRun(
  runId: string,
  oracle: Address,
  read: ReadCommit = readCommitFromChain,
): Promise<Verification> {
  const run = await fetchRunDocument(runId);
  let commit: CommitRead | null;
  try {
    commit = await read(oracle, runIdToBytes32(runId));
  } catch {
    const base = compare(run, null);
    base.steps[1] = {
      label: "HyvoOracle commit on Robinhood Chain",
      ok: false,
      detail: "the chain could not be read from this browser; try again, or check the RPC settings",
    };
    return base;
  }
  return compare(run, commit);
}
