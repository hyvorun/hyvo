/**
 * Hyvo Board's reads, in the visitor's browser. The first read takes the last hour of launches and the
 * last five minutes of trades, so the New column shows first, then the rest of the 24 hours for Final
 * stretch and Graduated. After that each read asks only for the blocks since the last one: the factory's
 * events, the curves' trades, the state of the curves that traded and every shown card's balances, in
 * Multicall3 batches. Reads pause while the tab is hidden and wait longer after errors.
 */
import {
  BOARD_REFRESH_MS,
  blocksIn,
  boardColumns,
  CARDS_PER_COLUMN,
  estimateTime,
  ETH,
  FIRST_SECOND_BLOCKS,
  firstSecondWallets,
  GRADUATED_HOURS,
  inPool,
  measurePace,
  NATIVE,
  NEW_MINUTES,
  nextDelay,
  nextScan,
  pruneTrades,
  readAssets,
  readFacts,
  readLaunchBuys,
  readRecords,
  readTradeLogs,
  scanFactory,
  shownCards,
  TRADE_MINUTES,
  verifyCurves,
  windowTrades,
  type BoardEntry,
  type BoardLaunch,
  type ChainReader,
  type FactsRead,
  type FactsRequest,
  type GraduationEvent,
  type LaunchEvent,
  type Snapshot,
  type Trade,
  type TradeWindow,
} from "@hyvo/launches";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { assetCache, launchesReader } from "../../lib/launches";
import { failureText } from "../launches/use-launches";

export { BOARD_REFRESH_MS };

/** A gap wider than this (a tab hidden a long time) makes the board read afresh instead of catching up. */
const MAX_GAP_SECONDS = 20 * 60;
/** Emitters of curve events checked against the factory per read, at most. */
const MAX_STRANGERS = 30;
/** Each refresh reads the last few seconds again, for logs an endpoint a little behind the head did not have yet. */
const OVERLAP_SECONDS = 10;

export interface BoardState {
  status: "loading" | "ready" | "error";
  /** Why the first read failed. */
  error: string | null;
  launches: BoardLaunch[];
  trades: Map<string, TradeWindow>;
  /** The head's time at the last read, in seconds. */
  now: number;
  /** The block the shown facts were read at. */
  read: Snapshot | null;
  /** The rest of the 24 hours, for Final stretch and Graduated. */
  history: "reading" | "ready" | "error";
  refreshing: boolean;
  /** False when the trades are counted on the shown curves only. */
  everyCurve: boolean;
  /** The last refresh failed: the board keeps what it read and tries again. */
  stale: string | null;
  served: string[];
}

const START: BoardState = {
  status: "loading",
  error: null,
  launches: [],
  trades: new Map(),
  now: 0,
  read: null,
  history: "reading",
  refreshing: true,
  everyCurve: true,
  stale: null,
  served: [],
};

type Stored = Omit<FactsRead, "liquidity" | "graduated"> & { liquidity?: bigint | null; graduated?: boolean | null };

interface Model {
  reader: ChainReader;
  pace: number | null;
  head: Snapshot | null;
  scannedTo: bigint | null;
  entries: Map<string, BoardEntry>;
  curves: Map<string, string>;
  graduations: Map<string, { block: bigint; timestamp: number | null }>;
  /** Tokens of graduations the factory's record was asked for. */
  recordsAsked: Set<string>;
  /** Emitters already checked against the factory. */
  checked: Set<string>;
  trades: Trade[];
  facts: Map<string, Stored>;
  /** Tokens whose curve state must be read again. */
  dirty: Set<string>;
  firstSecond: Map<string, Address[] | "failed">;
  everyCurve: boolean;
  read: Snapshot | null;
  history: BoardState["history"];
}

function newModel(): Model {
  return {
    reader: launchesReader(),
    pace: null,
    head: null,
    scannedTo: null,
    entries: new Map(),
    curves: new Map(),
    graduations: new Map(),
    recordsAsked: new Set(),
    checked: new Set(),
    trades: [],
    facts: new Map(),
    dirty: new Set(),
    firstSecond: new Map(),
    everyCurve: true,
    read: null,
    history: "reading",
  };
}

const lower = (value: string) => value.toLowerCase();

function addEntry(model: Model, entry: BoardEntry): void {
  const key = lower(entry.token);
  const known = model.entries.get(key);
  // A launch event has its block; a record does not. The event wins.
  if (known && (known.block !== null || entry.block === null)) return;
  model.entries.set(key, entry);
  model.curves.set(lower(entry.curve), key);
  model.dirty.add(key);
}

function addFactory(model: Model, scan: { launches: LaunchEvent[]; graduations: GraduationEvent[] }): void {
  for (const event of scan.launches) {
    addEntry(model, {
      token: event.token,
      curve: event.curve,
      creator: event.creator,
      pairToken: event.pairToken,
      graduationThreshold: event.graduationThreshold,
      block: event.block,
      timestamp: event.timestamp,
    });
  }
  for (const event of scan.graduations) {
    const key = lower(event.token);
    model.graduations.set(key, { block: event.block, timestamp: event.timestamp });
    model.dirty.add(key);
  }
}

const tradeId = (trade: Trade) => `${trade.txHash}:${trade.logIndex}`;

function addTrades(model: Model, trades: readonly Trade[]): void {
  const { head, pace } = model;
  // Blocks read again (the overlap, or a read that failed half way) bring the same logs back: each counts once.
  const seen = new Set(model.trades.map(tradeId));
  for (const trade of trades) {
    const key = model.curves.get(lower(trade.curve));
    if (key) model.dirty.add(key);
    if (seen.has(tradeId(trade))) continue;
    seen.add(tradeId(trade));
    const stamped = trade.timestamp === null && head && pace ? { ...trade, timestamp: estimateTime(trade.block, head, pace) } : trade;
    model.trades.push(stamped);
  }
}

function merge(model: Model, facts: Map<string, FactsRead>): void {
  for (const [key, row] of facts) {
    const stored = model.facts.get(key) ?? {};
    const next: Stored = { ...stored };
    for (const [field, value] of Object.entries(row) as [keyof FactsRead, unknown][]) {
      if (value !== undefined) (next as Record<string, unknown>)[field] = value;
    }
    model.facts.set(key, next);
  }
}

function launchesOf(model: Model): BoardLaunch[] {
  const { head, pace } = model;
  const timeOf = (block: bigint) => (head && pace ? estimateTime(block, head, pace) : null);
  return [...model.entries.entries()].map(([key, entry]) => {
    const facts = model.facts.get(key) ?? {};
    const graduation = model.graduations.get(key);
    const first = model.firstSecond.get(key);
    const pair = lower(entry.pairToken) === lower(NATIVE) ? ETH : (assetCache.get(lower(entry.pairToken)) ?? null);
    return {
      token: entry.token,
      curve: entry.curve,
      creator: entry.creator,
      pair,
      symbol: facts.symbol ?? null,
      name: facts.name ?? null,
      block: entry.block,
      launchedAt: facts.launchedAt ?? entry.timestamp ?? (entry.block !== null ? timeOf(entry.block) : null),
      graduationThreshold: entry.graduationThreshold,
      creatorTaxBps: facts.creatorTaxBps ?? null,
      graduated: facts.graduated ?? null,
      liquidity: facts.liquidity ?? null,
      graduatedAt: graduation ? (graduation.timestamp ?? timeOf(graduation.block)) : null,
      supply: facts.supply ?? null,
      creatorBalance: facts.creatorBalance ?? null,
      curveBalance: facts.curveBalance ?? null,
      firstSecond: Array.isArray(first) ? { wallets: first.length, balance: facts.walletsBalance ?? null } : null,
    };
  });
}

function shown(model: Model): BoardLaunch[] {
  return shownCards(boardColumns(launchesOf(model), model.head?.timestamp ?? 0), CARDS_PER_COLUMN);
}

/** Factory events and trades over [from, to], then the launches they name that the board does not know yet. */
async function scan(model: Model, from: bigint, to: bigint, tradesFrom: bigint): Promise<void> {
  const { reader } = model;
  addFactory(model, await scanFactory(reader, from, to));
  const fallback = shown(model)
    .filter((launch) => launch.graduated !== true)
    .map((launch) => launch.curve);
  const logs = await readTradeLogs(reader, tradesFrom > from ? tradesFrom : from, to, fallback.length > 0 ? fallback : [...model.entries.values()].slice(0, 40).map((entry) => entry.curve));
  model.everyCurve = logs.everyCurve;
  addTrades(model, logs.trades);

  // Curves trading now whose launch was not read: the factory's record says whether each is a Pons curve.
  const counts = new Map<string, { curve: Address; trades: number }>();
  for (const trade of logs.trades) {
    const key = lower(trade.curve);
    if (model.curves.has(key) || model.checked.has(key)) continue;
    const row = counts.get(key) ?? { curve: trade.curve, trades: 0 };
    row.trades += 1;
    counts.set(key, row);
  }
  const strangers = [...counts.values()].sort((a, b) => b.trades - a.trades).slice(0, MAX_STRANGERS);
  if (strangers.length > 0) {
    const found = await verifyCurves(
      reader,
      strangers.map((stranger) => stranger.curve),
    );
    // Marked once answered: after a failed read they are asked again.
    for (const stranger of strangers) model.checked.add(lower(stranger.curve));
    for (const entry of found) addEntry(model, entry);
  }
  await resolveGraduations(model);
}

/** Graduations whose launch is older than the blocks read: the factory's record. */
async function resolveGraduations(model: Model): Promise<void> {
  const missing = [...model.graduations.keys()].filter((key) => !model.entries.has(key) && !model.recordsAsked.has(key));
  if (missing.length === 0) return;
  const found = await readRecords(model.reader, missing as Address[]);
  for (const key of missing) model.recordsAsked.add(key);
  for (const entry of found) addEntry(model, entry);
}

/** The state of the curves that changed, then every shown card's facts and balances, at one block each. */
async function readState(model: Model): Promise<void> {
  const { reader } = model;
  // A curve that has stopped trading does not change again.
  const dirty = [...model.dirty];
  const changed = dirty.filter((key) => model.entries.has(key) && model.facts.get(key)?.graduated !== true);
  if (changed.length > 0) {
    const answer = await readFacts(
      reader,
      changed.map((key) => ({ entry: model.entries.get(key)!, statics: false, balances: false })),
    );
    merge(model, answer.facts);
    model.read = answer.read;
  }
  // Cleared once read: after a failed read the same curves are read next time.
  for (const key of dirty) model.dirty.delete(key);
  const cards = shown(model);
  if (cards.length === 0) return;
  const pairs = cards.map((card) => model.entries.get(lower(card.token))!.pairToken);
  await readAssets(reader, pairs, assetCache);
  const requests: FactsRequest[] = cards.map((card) => {
    const key = lower(card.token);
    const first = model.firstSecond.get(key);
    return {
      entry: model.entries.get(key)!,
      statics: model.facts.get(key)?.symbol === undefined,
      balances: true,
      // Until the first-second wallets are known, their total is not given (not 0).
      ...(Array.isArray(first) ? { wallets: first } : {}),
    };
  });
  const answer = await readFacts(reader, requests);
  merge(model, answer.facts);
  model.read = answer.read;
}

/**
 * The wallets that bought in each shown card's launch second, and their balances. Read once per launch, so
 * only once the blocks searched are all behind the head: a launch still in its first seconds waits a read.
 */
async function readFirstSeconds(model: Model): Promise<void> {
  const { reader, head } = model;
  if (!head) return;
  const wanted = shown(model).filter(
    (card) => card.block !== null && card.block + FIRST_SECOND_BLOCKS <= head.block && !model.firstSecond.has(lower(card.token)) && model.facts.get(lower(card.token))?.launchedAt,
  );
  if (wanted.length === 0) return;
  await inPool(wanted, 3, async (card) => {
    const key = lower(card.token);
    const launchedAt = model.facts.get(key)!.launchedAt!;
    try {
      const buys = await readLaunchBuys(reader, { curve: card.curve, block: card.block!, launchedAt }, head.block);
      model.firstSecond.set(key, firstSecondWallets(buys, { curve: card.curve, token: card.token, creator: card.creator, launchedAt }));
    } catch {
      model.firstSecond.set(key, "failed");
    }
  });
  const requests: FactsRequest[] = wanted.flatMap((card) => {
    const key = lower(card.token);
    const first = model.firstSecond.get(key);
    return Array.isArray(first) ? [{ entry: model.entries.get(key)!, statics: false, balances: true, wallets: first }] : [];
  });
  if (requests.length === 0) return;
  const answer = await readFacts(reader, requests);
  merge(model, answer.facts);
  // The block named is the oldest the cards were read at, as on the launch pages.
  if (!model.read || answer.read.block < model.read.block) model.read = answer.read;
}

/** One read of the board. `publish` shows what is read so far. */
async function tick(model: Model, publish: () => void, live: () => boolean): Promise<void> {
  const { reader } = model;
  const top = await reader.header("latest");
  const head: Snapshot = { block: top.number, timestamp: top.timestamp };
  if (model.pace === null) model.pace = await measurePace(reader, head);
  const pace = model.pace;
  const tradesFrom = head.block - blocksIn(TRADE_MINUTES * 60, pace) + 1n;
  const range = model.scannedTo === null ? "first" : nextScan(model.scannedTo, head.block, blocksIn(MAX_GAP_SECONDS, pace));
  if (range === "restart") {
    Object.assign(model, newModel(), { pace });
    return tick(model, publish, live);
  }
  model.head = head;
  const firstFrom = head.block - blocksIn(NEW_MINUTES * 60 + 120, pace) + 1n;
  if (range === "first") await scan(model, firstFrom, head.block, tradesFrom);
  else if (range) {
    // Every trade since the last read, not only the last five minutes', marks its curve to read again,
    // or a curve that traded while the tab was hidden would keep its old state.
    const from = range.from - blocksIn(OVERLAP_SECONDS, pace);
    await scan(model, from, range.to, from);
  }
  model.scannedTo = head.block;
  model.trades = pruneTrades(model.trades, head.timestamp - TRADE_MINUTES * 60);
  await readState(model);
  publish();
  if (!live()) return;
  await readFirstSeconds(model);
  publish();

  // Until it is read: a first read that failed after showing the last hour tries again on the next.
  if (model.history === "reading" && live()) {
    // The rest of the 24 hours: older launches that may be close to graduating, and the pools created.
    try {
      const from = head.block - blocksIn(GRADUATED_HOURS * 3600, pace) + 1n;
      addFactory(model, await scanFactory(reader, from, firstFrom - 1n));
      await resolveGraduations(model);
      await readState(model);
      model.history = "ready";
      publish();
      await readFirstSeconds(model);
    } catch {
      model.history = "error";
    }
    publish();
  }
}

/**
 * The board, read again every `refreshMs` while the page is open and visible. A later step sets the
 * interval per viewer.
 */
export function useBoard(refreshMs: number = BOARD_REFRESH_MS, attempt = 0): BoardState {
  const [state, setState] = useState<BoardState>(START);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let failures = 0;
    let running = false;
    let lastRun = 0;
    let status: BoardState["status"] = "loading";
    let stale: string | null = null;
    const model = newModel();
    model.reader.warm();
    setState(START);

    const publish = (refreshing = running) => {
      if (!live) return;
      const now = model.head?.timestamp ?? Math.floor(Date.now() / 1000);
      setState((current) => ({
        ...current,
        status,
        launches: launchesOf(model),
        trades: windowTrades(model.trades, now - TRADE_MINUTES * 60),
        now,
        read: model.read,
        history: model.history,
        refreshing,
        everyCurve: model.everyCurve,
        stale,
        served: [...model.reader.served],
      }));
    };

    const schedule = () => {
      if (!live || status === "error") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, nextDelay(refreshMs, failures));
    };

    const run = async () => {
      if (!live || running) return;
      // Hidden: no reads until the tab is visible again.
      if (document.visibilityState === "hidden") return;
      running = true;
      lastRun = Date.now();
      if (status === "ready") setState((current) => ({ ...current, refreshing: true }));
      try {
        await tick(
          model,
          () => {
            if (status === "loading") status = "ready";
            publish(true);
          },
          () => live,
        );
        failures = 0;
        stale = null;
        status = "ready";
      } catch (error) {
        failures += 1;
        if (status === "loading") {
          status = "error";
          if (live) setState((current) => ({ ...current, status: "error", error: failureText(error), refreshing: false }));
        } else {
          stale = failureText(error);
        }
      } finally {
        running = false;
        if (status !== "error") publish(false);
        schedule();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible" || running || status === "error") return;
      if (Date.now() - lastRun >= refreshMs) {
        window.clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void run();
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshMs, attempt]);

  return state;
}
