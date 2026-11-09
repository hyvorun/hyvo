/**
 * Loading Hyvo Launches in steps, so the newest launches show while the rest of the window is still
 * being read: the last few thousand blocks first, then the most traded curves, then the whole window.
 */
import {
  findLaunchEvent,
  measurePace,
  readCurveTrades,
  readLaunch,
  readLaunches,
  readMovers,
  scanFactory,
  summarizeTrades,
  type Activity,
  type GraduationEvent,
  type Launch,
  type LaunchEvent,
  type Lookup,
  type Movers,
  type Snapshot,
  type Trade,
} from "@hyvo/launches";
import { useEffect, useState } from "react";
import { assetCache, launchesReader, RECENT_MINUTES } from "../../lib/launches";

/** Blocks read first: about half an hour at Robinhood Chain's pace. */
const FIRST_BLOCKS = 20_000n;
const MOVERS_SHOWN = 8;

export interface WindowState {
  status: "loading" | "partial" | "ready" | "error";
  error: string | null;
  /** Each block the curves' state was read at, in the order the reads happened. */
  reads: Snapshot[];
  head: Snapshot | null;
  pace: number | null;
  fromBlock: bigint | null;
  launches: Launch[];
  graduations: GraduationEvent[];
  served: string[];
  movers: { status: "loading" | "ready" | "error"; data: Movers | null; error: string | null };
}

const START: WindowState = {
  status: "loading",
  error: null,
  reads: [],
  head: null,
  pace: null,
  fromBlock: null,
  launches: [],
  graduations: [],
  served: [],
  movers: { status: "loading", data: null, error: null },
};

export function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /No public endpoint answered/.test(message)
    ? "Robinhood Chain's public endpoints did not answer just now. They are sometimes busy, and some networks block them."
    : "The chain could not be read just now.";
}

export function useLaunchWindow(hours: number, attempt: number): WindowState {
  const [state, setState] = useState<WindowState>(START);

  useEffect(() => {
    let live = true;
    const update = (patch: Partial<WindowState> | ((current: WindowState) => Partial<WindowState>)) => {
      if (!live) return;
      setState((current) => ({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }));
    };
    setState(START);
    const reader = launchesReader();
    reader.warm();

    (async () => {
      const top = await reader.header("latest");
      const head: Snapshot = { block: top.number, timestamp: top.timestamp };
      const pacing = measurePace(reader, head);
      update({ head });

      // 1. The newest launches.
      const firstFrom = head.block - FIRST_BLOCKS + 1n;
      const first = await scanFactory(reader, firstFrom, head.block);
      const newest = await readLaunches(reader, first.launches, assetCache);
      update({ status: "partial", reads: [newest.read], launches: newest.launches, graduations: first.graduations, fromBlock: firstFrom, served: [...reader.served] });

      const pace = await pacing;
      update({ pace });

      // 2. The most traded curves, and 3. the rest of the window, side by side.
      const recent = BigInt(Math.round(RECENT_MINUTES * 60 * pace));
      const movers = readMovers(reader, { fromBlock: head.block - recent + 1n, toBlock: head.block, known: newest.launches, limit: MOVERS_SHOWN, cache: assetCache }).then(
        (data) =>
          update((current) => ({
            movers: { status: "ready", data, error: null },
            reads: data.read ? [...current.reads, data.read] : current.reads,
            served: [...reader.served],
          })),
        (error: unknown) => update({ movers: { status: "error", data: null, error: failureText(error) } }),
      );

      const span = BigInt(Math.round(hours * 3600 * pace));
      const from = head.block - span + 1n;
      if (from < firstFrom) {
        const rest = await scanFactory(reader, from, firstFrom - 1n);
        const older = await readLaunches(reader, rest.launches, assetCache);
        update((current) => ({
          launches: [...current.launches, ...older.launches],
          graduations: [...current.graduations, ...rest.graduations],
          reads: older.launches.length > 0 ? [...current.reads, older.read] : current.reads,
          fromBlock: from,
        }));
      } else if (from > firstFrom) {
        // A window shorter than the first read keeps only its own launches.
        update((current) => ({
          launches: current.launches.filter((launch) => launch.block === null || launch.block >= from),
          graduations: current.graduations.filter((graduation) => graduation.block >= from),
          fromBlock: from,
        }));
      }
      update({ status: "ready", served: [...reader.served] });
      await movers;
    })().catch((error: unknown) => update({ status: "error", error: failureText(error) }));

    return () => {
      live = false;
    };
  }, [hours, attempt]);

  return state;
}

export interface LaunchState {
  status: "loading" | "ready" | "error";
  error: string | null;
  lookup: Lookup | null;
  pace: number | null;
  trades: { status: "loading" | "ready" | "error"; list: Trade[]; summary: Activity | null; fromBlock: bigint | null; toBlock: bigint | null };
  event: { status: "loading" | "ready" | "error"; data: LaunchEvent | null };
  served: string[];
}

const LAUNCH_START: LaunchState = {
  status: "loading",
  error: null,
  lookup: null,
  pace: null,
  trades: { status: "loading", list: [], summary: null, fromBlock: null, toBlock: null },
  event: { status: "loading", data: null },
  served: [],
};

/** The trades of one curve over the last hour. */
const TRADE_HOURS = 1;

export function useLaunch(token: `0x${string}` | null, attempt: number): LaunchState {
  const [state, setState] = useState<LaunchState>(LAUNCH_START);

  useEffect(() => {
    if (!token) return;
    let live = true;
    const update = (patch: Partial<LaunchState>) => live && setState((current) => ({ ...current, ...patch }));
    setState(LAUNCH_START);
    const reader = launchesReader();
    reader.warm();

    (async () => {
      const lookup = await readLaunch(reader, token, assetCache);
      update({ status: "ready", lookup, served: [...reader.served] });
      if (lookup.kind !== "v2") return;
      const detail = lookup.detail;
      const pace = await measurePace(reader, detail.read);
      update({ pace });
      const span = BigInt(Math.round(TRADE_HOURS * 3600 * pace));
      const fromBlock = detail.read.block - span + 1n;
      const trades = readCurveTrades(reader, detail.curve, fromBlock, detail.read.block).then(
        (list) => update({ trades: { status: "ready", list, summary: summarizeTrades(list).get(detail.curve.toLowerCase()) ?? null, fromBlock, toBlock: detail.read.block } }),
        () => update({ trades: { status: "error", list: [], summary: null, fromBlock, toBlock: detail.read.block } }),
      );
      const event = detail.launchedAt
        ? findLaunchEvent(reader, detail.token, { launchedAt: detail.launchedAt, head: detail.read, blocksPerSecond: pace }).then(
            (data) => update({ event: { status: "ready", data } }),
            () => update({ event: { status: "error", data: null } }),
          )
        : Promise.resolve(update({ event: { status: "ready", data: null } }));
      await Promise.all([trades, event]);
      update({ served: [...reader.served] });
    })().catch((error: unknown) => update({ status: "error", error: failureText(error) }));

    return () => {
      live = false;
    };
  }, [token, attempt]);

  return state;
}
