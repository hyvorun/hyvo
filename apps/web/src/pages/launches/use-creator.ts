/**
 * A creator's launches and a launch's holder scan. Which launches one wallet made comes from Hyvo's API
 * (`GET /v1/launches/creator/:address`: the factory's TokenLaunched logs in Blockscout's index); everything
 * about each launch now, and every balance, is read from the chain in the visitor's browser.
 */
import {
  FACTORY_ABI,
  PONS_V2_FACTORY,
  computeHolderScan,
  creatorLaunchFromJson,
  multicall,
  phaseFromIndex,
  readFirstSecondBuyers,
  readHolderBalances,
  readLaunches,
  type CreatorLaunch,
  type HolderScan,
  type Launch,
  type LaunchDetail,
  type LaunchEvent,
  type Phase,
  type Snapshot,
} from "@hyvo/launches";
import { CreatorLaunchesResponse } from "@hyvo/schema";
import { useEffect, useState } from "react";
import { API_URL } from "../../lib/api";
import { assetCache, launchesReader } from "../../lib/launches";
import { fetchHolderFacts } from "../../lib/use-check";
import { failureText } from "./use-launches";

/** How long the page waits for Hyvo's API. */
const API_TIMEOUT_MS = 10_000;
/** Launches whose state is read on the creator page at most, newest first. */
export const CREATOR_STATES_READ = 300;

export type CreatorAnswer = { ok: true; data: CreatorLaunchesResponse; launches: CreatorLaunch[] } | { ok: false; message: string };

/** The creator's launches from Hyvo's API; never throws: no answer says why, in words a visitor can act on. */
export async function fetchCreatorLaunches(address: string, signal?: AbortSignal): Promise<CreatorAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop);
  try {
    const response = await fetch(`${API_URL}/v1/launches/creator/${address}`, { headers: { Accept: "application/json" }, signal: controller.signal });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 429) return { ok: false, message: "Hyvo's API has had many requests from this connection. Try again in a minute." };
    if (response.status === 503) return { ok: false, message: "Hyvo's API does not read Blockscout's index at the moment, so a wallet's launches cannot be listed. Try again later." };
    if (response.status === 400) return { ok: false, message: "That is not a wallet address: 0x followed by 40 hexadecimal characters." };
    const parsed = CreatorLaunchesResponse.safeParse(body);
    if (!response.ok || !parsed.success) return { ok: false, message: "Hyvo's API did not answer with this wallet's launches. Try again in a minute." };
    if (parsed.data.launches === null) return { ok: false, message: `${parsed.data.missing ?? "Blockscout's index could not be read just now"}.` };
    const launches = parsed.data.launches.map(creatorLaunchFromJson).filter((launch): launch is CreatorLaunch => launch !== null);
    return { ok: true, data: parsed.data, launches };
  } catch {
    return { ok: false, message: "Hyvo's API could not be reached. Check your connection and try again." };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * Each token's phase from the factory's record, in one Multicall3 batch per 300 tokens. A token whose record
 * does not name `creator` as its deployer is left out: the chain has the last word over the index.
 */
async function readPhases(creator: string, tokens: readonly CreatorLaunch[]): Promise<{ phases: Map<string, Phase | null>; read: Snapshot }> {
  const reader = launchesReader();
  const answer = await multicall(
    reader,
    tokens.map((launch) => ({ address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [launch.token] })),
  );
  const phases = new Map<string, Phase | null>();
  tokens.forEach((launch, i) => {
    const result = answer.results[i];
    const record = result?.ok ? (result.value as { exists: boolean; phase: number; token: string; deployer: string }) : null;
    if (!record?.exists || record.token.toLowerCase() !== launch.token.toLowerCase() || record.deployer.toLowerCase() !== creator.toLowerCase()) return;
    phases.set(launch.token.toLowerCase(), phaseFromIndex(Number(record.phase)));
  });
  return { phases, read: { block: answer.block, timestamp: answer.timestamp } };
}

export interface CreatorState {
  status: "loading" | "ready" | "error";
  error: string | null;
  answer: Extract<CreatorAnswer, { ok: true }> | null;
  /** Each launch's state now, newest first ("full" only). */
  launches: Launch[];
  phases: Map<string, Phase | null>;
  chain: "loading" | "ready" | "error";
  chainError: string | null;
  reads: Snapshot[];
  served: string[];
}

const CREATOR_START: CreatorState = { status: "loading", error: null, answer: null, launches: [], phases: new Map(), chain: "loading", chainError: null, reads: [], served: [] };

/**
 * A wallet's launches: the list from Hyvo's API, then from the chain each one's phase ("count") or its
 * curve's whole state too ("full").
 */
export function useCreator(address: `0x${string}` | null, attempt: number, mode: "full" | "count"): CreatorState {
  const [state, setState] = useState<CreatorState>(CREATOR_START);
  useEffect(() => {
    if (!address) return;
    let live = true;
    const controller = new AbortController();
    const update = (patch: Partial<CreatorState>) => live && setState((current) => ({ ...current, ...patch }));
    setState(CREATOR_START);
    (async () => {
      const answer = await fetchCreatorLaunches(address, controller.signal);
      if (!answer.ok) return update({ status: "error", error: answer.message });
      update({ status: "ready", answer });
      if (answer.launches.length === 0) return update({ chain: "ready" });
      const shown = answer.launches.slice(0, CREATOR_STATES_READ);
      try {
        const reader = launchesReader();
        reader.warm();
        const [phases, states] = await Promise.all([
          readPhases(address, shown),
          mode === "full"
            ? readLaunches(
                reader,
                shown.map(
                  (launch): LaunchEvent => ({
                    token: launch.token,
                    curve: launch.curve,
                    creator: address,
                    pairToken: launch.pairToken,
                    launchConfigId: launch.launchConfigId,
                    graduationThreshold: launch.graduationThreshold,
                    block: launch.block,
                    txHash: launch.txHash,
                    logIndex: launch.logIndex,
                    timestamp: launch.timestamp,
                  }),
                ),
                assetCache,
              )
            : Promise.resolve(null),
        ]);
        update({
          chain: "ready",
          phases: phases.phases,
          launches: (states?.launches ?? []).filter((launch) => phases.phases.has(launch.token.toLowerCase())),
          reads: states ? [phases.read, states.read] : [phases.read],
          served: [...reader.served],
        });
      } catch (error) {
        update({ chain: "error", chainError: failureText(error) });
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [address, attempt, mode]);
  return state;
}

/** Graduated: the factory's record says its Uniswap V4 pool was created. */
export function graduatedCount(phases: ReadonlyMap<string, Phase | null>): number {
  let count = 0;
  for (const phase of phases.values()) if (phase === "graduated") count += 1;
  return count;
}

export interface ScanState {
  status: "waiting" | "loading" | "ready" | "error";
  error: string | null;
  scan: HolderScan | null;
  /** Where Blockscout's list came from and when, or why it is missing. */
  listSource: string | null;
  listMissing: string | null;
  /** The launch-second blocks, when its buys were read. */
  second: { fromBlock: bigint; toBlock: bigint } | null;
  secondMissing: string | null;
  read: Snapshot | null;
}

const SCAN_START: ScanState = { status: "waiting", error: null, scan: null, listSource: null, listMissing: null, second: null, secondMissing: null, read: null };

/**
 * The holder scan of one launch: Blockscout's largest holders through Hyvo's API (addresses only), the buyers
 * of the launch second from the curve's CurveBuy logs, then every balance and the supply at one block.
 * Starts once the search for the launch event is over (`event` undefined until then).
 */
export function useHolderScan(detail: LaunchDetail | null, event: LaunchEvent | null | undefined, attempt: number): ScanState {
  const [state, setState] = useState<ScanState>(SCAN_START);
  useEffect(() => {
    if (!detail || event === undefined) return;
    let live = true;
    const controller = new AbortController();
    setState({ ...SCAN_START, status: "loading" });
    (async () => {
      const reader = launchesReader();
      const second =
        event && detail.launchedAt
          ? readFirstSecondBuyers(reader, { curve: detail.curve, launchBlock: event.block, launchedAt: detail.launchedAt }).catch(() => null)
          : Promise.resolve(null);
      const [facts, buys] = await Promise.all([fetchHolderFacts(detail.token, controller.signal), second]);
      const listed = facts.holders?.map((holder) => holder.address) ?? null;
      const buyers = buys?.buyers ?? null;
      const read = await readHolderBalances(reader, { token: detail.token, addresses: [...(listed ?? []), detail.creator, detail.curve, ...(buyers ?? [])] });
      const scan = computeHolderScan({
        supply: read.supply,
        holderCount: facts.holderCount,
        listed,
        balances: read.balances,
        creator: detail.creator,
        curve: detail.curve,
        poolManager: read.poolManager,
        firstSecondBuyers: buyers,
      });
      if (!live) return;
      setState({
        status: "ready",
        error: null,
        scan,
        listSource: facts.holders ? facts.source : null,
        listMissing: facts.holders ? null : facts.holdersMissing,
        second: buys ? { fromBlock: buys.fromBlock, toBlock: buys.toBlock } : null,
        secondMissing: buys ? null : event ? "The buys of the launch second could not be read just now." : "The launch transaction was not found, so the launch second's buys were not read.",
        read: read.read,
      });
    })().catch((error: unknown) => live && setState({ ...SCAN_START, status: "error", error: failureText(error) }));
    return () => {
      live = false;
      controller.abort();
    };
  }, [detail, event, attempt]);
  return state;
}
