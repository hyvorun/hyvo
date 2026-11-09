/**
 * Hyvo Board: every Pons V2 launch on Robinhood Chain as it happens, in three columns. New: launched in
 * the last hour. Final stretch: still on its curve and at least half way to graduating. Graduated: its
 * pool created in the last 24 hours. A launch sits in one column only, the furthest it has reached.
 *
 * Pure: no reads here (board-read.ts reads). Every figure is arithmetic on numbers the chain holds, at
 * the block named with them, and a flag only states one of those numbers when it passes a threshold set
 * below. Nothing here rates a token or a wallet.
 *
 * From the verified source (docs/OPEN_ITEMS.md item 31): PonsV2LauncherToken is an OpenZeppelin ERC20
 * that mints its whole supply to the curve, the curve's `launchSupply` is that supply, its `launchedAt`
 * is the launch block's time, and a `CurveBuy` sends the tokens bought to its `recipient`.
 */
import type { Address } from "viem";
import { formatBps, formatPercent, progress } from "./facts";
import type { Asset, Snapshot, Trade } from "./read";

/** How often the board reads the chain again while it is open and visible. */
export const BOARD_REFRESH_MS = 15_000;
/** The New column: launched in the last hour. */
export const NEW_MINUTES = 60;
/** The Graduated column: pool created in the last 24 hours. */
export const GRADUATED_HOURS = 24;
/** The Final stretch column: at least half way to graduating. */
export const STRETCH_PROGRESS = 0.5;
/** Each card counts the trades on its curve over the last five minutes. */
export const TRADE_MINUTES = 5;
/** Cards a column shows; the rest are counted. */
export const CARDS_PER_COLUMN = 12;
/**
 * Blocks after a launch's block searched for buys in the launch second. At the pace measured on Robinhood
 * Chain (about 9.6 blocks a second, item 29) that is about six seconds; only the blocks whose time is the
 * curve's `launchedAt` count.
 */
export const FIRST_SECOND_BLOCKS = 60n;
/** Wallets of the launch second whose balances are read, at most. */
export const FIRST_SECOND_MAX_WALLETS = 40;
/** Flags. The creator's wallet holds at least this share of the supply. */
export const CREATOR_SHARE_FLAG = 0.05;
/** The wallets that bought in the launch second hold at least this share of the supply, together. */
export const FIRST_SECOND_SHARE_FLAG = 0.1;
/** The creator tax set at launch is at least this, in basis points. */
export const CREATOR_TAX_FLAG_BPS = 500;
/** The longest wait between reads after errors. */
export const BACKOFF_MAX_MS = 120_000;

export type ColumnId = "new" | "stretch" | "graduated";

export const COLUMN_IDS: readonly ColumnId[] = ["new", "stretch", "graduated"];

/** A launch the board knows of, before its curve is read. */
export interface BoardEntry {
  token: Address;
  curve: Address;
  /** The `deployer` Pons records as the creator. */
  creator: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  /** The block of its `TokenLaunched` event; null for a launch found through the factory's record. */
  block: bigint | null;
  /** That block's time, when the log carried it. */
  timestamp: number | null;
}

/** One card: a launch with what was read of it. Null means not read (yet). */
export interface BoardLaunch {
  token: Address;
  curve: Address;
  creator: Address;
  pair: Asset | null;
  symbol: string | null;
  name: string | null;
  block: bigint | null;
  /** When trading opened (the curve's launchedAt), else the launch block's time. */
  launchedAt: number | null;
  graduationThreshold: bigint;
  creatorTaxBps: number | null;
  graduated: boolean | null;
  /** Pair asset the curve holds (realQuoteReserve), in its smallest unit. */
  liquidity: bigint | null;
  /** When the factory created its pool (`PoolGraduated`), if that event was read. */
  graduatedAt: number | null;
  /** The curve's launchSupply. */
  supply: bigint | null;
  creatorBalance: bigint | null;
  curveBalance: bigint | null;
  /** The wallets that bought in the launch second, the creator's left out, and what they hold now together. */
  firstSecond: { wallets: number; balance: bigint | null } | null;
}

export interface TradeWindow {
  buys: number;
  sells: number;
  /** Pair asset traded, before fee and tax, in its smallest unit. */
  volume: bigint;
  /** Distinct wallets the buys went to. */
  buyers: number;
}

export const NO_TRADES: TradeWindow = { buys: 0, sells: 0, volume: 0n, buyers: 0 };

export type Columns = Record<ColumnId, BoardLaunch[]>;

const lower = (value: string) => value.toLowerCase();

/** How far the curve is towards graduating, from 0 to 1; a graduated launch is done. */
export function curveProgress(launch: Pick<BoardLaunch, "graduated" | "liquidity" | "graduationThreshold">): number | null {
  if (launch.graduated === true) return 1;
  return progress(launch.liquidity, launch.graduationThreshold);
}

/** `amount` over `supply`, from 0 to 1, or null when either is unknown. */
export function shareOf(amount: bigint | null, supply: bigint | null): number | null {
  if (amount === null || supply === null || supply <= 0n) return null;
  if (amount <= 0n) return 0;
  if (amount >= supply) return 1;
  return Number((amount * 1_000_000n) / supply) / 1_000_000;
}

/** A block's time from the head's time and the chain's pace, for logs that did not carry their block's time. */
export function estimateTime(block: bigint, head: Snapshot, pace: number): number {
  if (pace <= 0) return head.timestamp;
  return Math.round(head.timestamp - Number(head.block - block) / pace);
}

/** Blocks in `seconds` at `pace`, at least one. */
export function blocksIn(seconds: number, pace: number): bigint {
  return BigInt(Math.max(1, Math.round(seconds * pace)));
}

/** The trades from `since` (seconds) on, per curve: buys, sells, volume and distinct buyers. Trades without a time are left out. */
export function windowTrades(trades: readonly Trade[], since: number): Map<string, TradeWindow> {
  const rows = new Map<string, TradeWindow & { people: Set<string> }>();
  for (const trade of trades) {
    if (trade.timestamp === null || trade.timestamp < since) continue;
    const key = lower(trade.curve);
    let row = rows.get(key);
    if (!row) {
      row = { ...NO_TRADES, people: new Set() };
      rows.set(key, row);
    }
    row.volume += trade.quote;
    if (trade.side === "buy") {
      row.buys += 1;
      row.people.add(lower(trade.trader));
    } else {
      row.sells += 1;
    }
  }
  const out = new Map<string, TradeWindow>();
  for (const [key, { people, ...row }] of rows) out.set(key, { ...row, buyers: people.size });
  return out;
}

/** Trades from `since` on; older ones are no longer needed. */
export function pruneTrades(trades: readonly Trade[], since: number): Trade[] {
  return trades.filter((trade) => trade.timestamp !== null && trade.timestamp >= since);
}

/**
 * The wallets the buys of the launch second went to: buys on the launch's curve in blocks whose time is
 * the curve's `launchedAt`. The creator's wallet is counted on its own, so it is left out, as are the
 * curve, the token and the zero address. In the order they first bought, at most `max`.
 */
export function firstSecondWallets(
  trades: readonly Trade[],
  launch: { curve: Address; token: Address; creator: Address; launchedAt: number },
  max = FIRST_SECOND_MAX_WALLETS,
): Address[] {
  const skip = new Set([launch.curve, launch.token, launch.creator, "0x0000000000000000000000000000000000000000"].map(lower));
  const ordered = trades
    .filter((trade) => trade.side === "buy" && lower(trade.curve) === lower(launch.curve) && trade.timestamp === launch.launchedAt)
    .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const trade of ordered) {
    const key = lower(trade.trader);
    if (skip.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(trade.trader);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The three columns at time `now` (seconds). A launch goes in the furthest column it has reached:
 * Graduated if its pool was created in the last 24 hours, else Final stretch if it is still on its curve
 * and at least half way, else New if it launched in the last hour; otherwise it is not on the board.
 */
export function boardColumns(launches: readonly BoardLaunch[], now: number): Columns {
  const columns: Columns = { new: [], stretch: [], graduated: [] };
  const seen = new Set<string>();
  for (const launch of launches) {
    const key = lower(launch.token);
    if (seen.has(key)) continue;
    seen.add(key);
    const column = columnOf(launch, now);
    if (column) columns[column].push(launch);
  }
  columns.graduated.sort((a, b) => (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0) || byToken(a, b));
  columns.stretch.sort((a, b) => (curveProgress(b) ?? 0) - (curveProgress(a) ?? 0) || newest(a, b));
  columns.new.sort(newest);
  return columns;
}

/** The column a launch belongs in at `now`, or null. */
export function columnOf(launch: BoardLaunch, now: number): ColumnId | null {
  if (launch.graduatedAt !== null && now - launch.graduatedAt <= GRADUATED_HOURS * 3600) return "graduated";
  if (launch.graduated === false) {
    const share = curveProgress(launch);
    if (share !== null && share >= STRETCH_PROGRESS) return "stretch";
  }
  // A launch whose curve has stopped trading is past New, whether or not its pool's event was read.
  if (launch.graduated === true) return null;
  if (launch.launchedAt !== null && now - launch.launchedAt <= NEW_MINUTES * 60) return "new";
  return null;
}

function newest(a: BoardLaunch, b: BoardLaunch): number {
  const time = (b.launchedAt ?? 0) - (a.launchedAt ?? 0);
  if (time !== 0) return time;
  const x = a.block ?? 0n;
  const y = b.block ?? 0n;
  if (x !== y) return x > y ? -1 : 1;
  return byToken(a, b);
}

function byToken(a: BoardLaunch, b: BoardLaunch): number {
  return lower(a.token) < lower(b.token) ? -1 : lower(a.token) > lower(b.token) ? 1 : 0;
}

/** The cards each column shows: the first `perColumn` of each. */
export function shownCards(columns: Columns, perColumn = CARDS_PER_COLUMN): BoardLaunch[] {
  return COLUMN_IDS.flatMap((id) => columns[id].slice(0, perColumn));
}

export type FlagId = "creator" | "first-second" | "tax";

export interface BoardFlag {
  id: FlagId;
  /** The fact, with its number: "Creator holds 62%". */
  text: string;
}

/** The facts on a card that pass a threshold above, each stated with its number. */
export function boardFlags(launch: BoardLaunch): BoardFlag[] {
  const flags: BoardFlag[] = [];
  const creator = shareOf(launch.creatorBalance, launch.supply);
  if (creator !== null && creator >= CREATOR_SHARE_FLAG) flags.push({ id: "creator", text: `Creator holds ${formatPercent(creator)}` });
  const first = launch.firstSecond ? shareOf(launch.firstSecond.balance, launch.supply) : null;
  if (first !== null && first >= FIRST_SECOND_SHARE_FLAG) flags.push({ id: "first-second", text: `First-second buyers hold ${formatPercent(first)}` });
  if (launch.creatorTaxBps !== null && launch.creatorTaxBps >= CREATOR_TAX_FLAG_BPS) flags.push({ id: "tax", text: `Creator tax ${formatBps(launch.creatorTaxBps)}` });
  return flags;
}

/**
 * The blocks to read logs over next: from the block after the last one read to the head. Null when
 * there is nothing new; "restart" when the gap is wider than `maxGap` blocks (the tab was hidden a long
 * time), so the board reads afresh instead of catching up.
 */
export function nextScan(scannedTo: bigint, head: bigint, maxGap: bigint): { from: bigint; to: bigint } | "restart" | null {
  if (head <= scannedTo) return null;
  if (head - scannedTo > maxGap) return "restart";
  return { from: scannedTo + 1n, to: head };
}

/** The wait before the next read: the interval, doubled after each failure in a row, at most BACKOFF_MAX_MS. */
export function nextDelay(intervalMs: number, failures: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(BACKOFF_MAX_MS, intervalMs * 2 ** Math.min(failures, 10));
}
