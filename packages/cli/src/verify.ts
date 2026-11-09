// `hyvo verify`: prove a published run from its file and the chain (docs/API.md, "Verifying a run").
//
//   1. the exact run.json bytes, through the SDK (`fetchRunBytes`), or a file the user already has;
//   2. the run hash, recomputed here: keccak-256 of RFC 8785 JSON without the top-level `hash`;
//   3. HyvoOracle.getCommit(runIdBytes32) on Robinhood Chain, read through the user's RPC from the contract this
//      build pins; its reportHash must equal the run hash and its scenarioHash the scenario's hash.
//
// The API is asked where the file is and what it recorded about the commit, and nothing more is taken from it.

import { decodeCommit, GET_COMMIT_SELECTOR, Hyvo, HyvoApiError } from "@hyvo/sdk";
import { DISCLAIMER, RunId, runIdToBytes32, scenarioHash, verifyRunHash } from "@hyvo/schema";
import { CommandError, describeError } from "./commands/common.js";
import { hostOf } from "./config.js";
import { oneLine } from "./format/text.js";
import { jsonRpc } from "./rpc.js";

export const RUN_DISCLAIMER: string = DISCLAIMER;

export interface VerifyTarget {
  /** A run id to download through the API, or the text of a run.json the user has. */
  runId?: string;
  file?: { path: string; text: string };
}

export interface VerifySettings {
  fetch: typeof fetch;
  apiUrl: string;
  rpcUrl: string;
  oracle: string;
  oracleFrom: "pinned" | "option";
  chainId: number;
}

export interface VerifyReport {
  runId: string;
  /** True only when the file hashes to its own hash and the chain holds both that hash and the scenario's. */
  verified: boolean;
  title: string | null;
  file: {
    source: "api" | "file";
    /** The local path, for a file the user gave. */
    path: string | null;
    /** The `hash` the file records. */
    hash: string | null;
    /** What the file hashes to, computed here. */
    recomputed: string;
    matches: boolean;
    /** keccak-256 of the RFC 8785 form of `scenario`. */
    scenarioHash: string | null;
  };
  chain: {
    chainId: number;
    oracle: string;
    oracleFrom: "pinned" | "option";
    rpc: string;
    /** HyvoOracle.getCommit as read through the RPC at the latest block; null when this run id was never committed. */
    commit: { reportHash: string; scenarioHash: string; committedAt: number } | null;
    reportHashMatches: boolean | null;
    scenarioHashMatches: boolean | null;
  };
  /** What the API records about the commit: its word, shown next to the proof, never part of it. */
  api: { host: string; oracleAddress: string | null; status: string | null; txHash: string | null; blockNumber: number | null } | null;
  disclaimer: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function apiFailure(error: unknown, runId: string, host: string): CommandError {
  if (error instanceof HyvoApiError) {
    if (error.status === 404) return new CommandError("not_found", `${host} has no published run ${runId}`);
    if (error.status === 503) return new CommandError("not_ready", `${host} published ${runId} moments ago and its file is not everywhere yet; try again in a minute`);
    return new CommandError("api", `${host} answered ${error.status}: ${error.message}`);
  }
  if (error instanceof Error && "issues" in error) {
    return new CommandError("api_shape", `${host} answered in a shape this version of hyvo does not know; a newer hyvo may read it`);
  }
  return new CommandError("api", describeError(error, host));
}

export async function verifyRun(target: VerifyTarget, s: VerifySettings): Promise<VerifyReport> {
  const apiHost = hostOf(s.apiUrl);
  let text: string;
  let apiInfo: VerifyReport["api"] = null;
  let summaryTitle: string | null = null;

  if (target.runId !== undefined) {
    if (!RunId.safeParse(target.runId).success) throw new CommandError("invalid_run_id", `not a run id: ${target.runId}`);
    const client = new Hyvo({ baseUrl: s.apiUrl, fetch: s.fetch });
    const [bytes, status] = await Promise.all([
      client.fetchRunBytes(target.runId).catch((error: unknown) => {
        throw apiFailure(error, target.runId!, apiHost);
      }),
      client.getRun(target.runId).catch(() => null),
    ]);
    text = bytes;
    summaryTitle = status?.run?.title ?? null;
    const oracle = status?.oracle ?? null;
    apiInfo = {
      host: apiHost,
      oracleAddress: oracle?.oracleAddress ?? null,
      status: oracle?.status ?? null,
      txHash: oracle?.txHash ?? null,
      blockNumber: oracle?.blockNumber ?? null,
    };
  } else if (target.file) {
    text = target.file.text;
  } else {
    throw new CommandError("invalid_run_id", "give a run id or a run.json file");
  }

  let run: unknown;
  try {
    run = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new CommandError("bad_file", target.file ? `${target.file.path} is not JSON` : `the run.json from ${apiHost} is not JSON`);
  }
  if (!isObject(run) || typeof run.runId !== "string" || !RunId.safeParse(run.runId).success) {
    throw new CommandError("bad_file", "this is not a run.json: it has no valid runId");
  }
  const runId = run.runId;
  if (target.runId !== undefined && runId !== target.runId) {
    throw new CommandError("wrong_run", `${apiHost} sent the file of ${runId}, not of ${target.runId}`);
  }

  let recomputed: { ok: boolean; expected: string; actual: string | null };
  let scenario: string | null;
  try {
    recomputed = verifyRunHash(run);
    scenario = isObject(run.scenario) ? scenarioHash(run.scenario) : null;
  } catch (error) {
    throw new CommandError("bad_file", `the run.json cannot be hashed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rpcHost = hostOf(s.rpcUrl);
  let chainIdHex: string;
  let result: string;
  try {
    [chainIdHex, result] = await Promise.all([
      jsonRpc(s.fetch, s.rpcUrl, "eth_chainId", []),
      jsonRpc(s.fetch, s.rpcUrl, "eth_call", [{ to: s.oracle, data: GET_COMMIT_SELECTOR + runIdToBytes32(runId).slice(2) }, "latest"]),
    ]);
  } catch (error) {
    throw new CommandError("rpc", `Robinhood Chain could not be read: ${describeError(error, rpcHost)}`);
  }
  const chainId = BigInt(chainIdHex === "0x" ? "0x0" : chainIdHex);
  if (chainId !== BigInt(s.chainId)) {
    throw new CommandError("wrong_chain", `${rpcHost} answers for chain ${chainId}, not Robinhood Chain (${s.chainId})`);
  }
  if (result.length < 2 + 6 * 64) {
    throw new CommandError("bad_oracle", `${s.oracle} did not answer getCommit(bytes32) on chain ${s.chainId}: it is not a HyvoOracle`);
  }
  const decoded = decodeCommit(result);
  const commit = decoded ? { reportHash: decoded.reportHash.toLowerCase(), scenarioHash: decoded.scenarioHash.toLowerCase(), committedAt: decoded.committedAt } : null;
  const reportHashMatches = commit ? commit.reportHash === recomputed.expected : null;
  const scenarioHashMatches = commit ? scenario !== null && commit.scenarioHash === scenario : null;

  const scenarioTitle = isObject(run.scenario) && typeof run.scenario.title === "string" ? run.scenario.title : null;
  const title = scenarioTitle ?? summaryTitle;
  return {
    runId,
    verified: recomputed.ok && reportHashMatches === true && scenarioHashMatches === true,
    title: title === null ? null : oneLine(title, 200),
    file: {
      source: target.file ? "file" : "api",
      path: target.file?.path ?? null,
      hash: recomputed.actual,
      recomputed: recomputed.expected,
      matches: recomputed.ok,
      scenarioHash: scenario,
    },
    chain: { chainId: s.chainId, oracle: s.oracle, oracleFrom: s.oracleFrom, rpc: rpcHost, commit, reportHashMatches, scenarioHashMatches },
    api: apiInfo,
    disclaimer: RUN_DISCLAIMER,
  };
}
