/**
 * A launch's holders, put together from facts read at one block: the wallets Blockscout's index lists as
 * the largest holders (their addresses only), each one's balance read on-chain, the creator's balance, and
 * the balances now of the wallets that bought on the curve in the launch second. Every share is of the
 * token's total supply at that block. Pure: this module makes no request, and it states figures, never a
 * judgement about the token or a wallet.
 */
import { getAddress, isAddress, type Address } from "viem";
import { multicall, type Read } from "./multicall";
import { ERC20_ABI, FACTORY_ABI, PONS_V2_FACTORY, TOPICS } from "./pons";
import { decodeTrades, type Snapshot } from "./read";
import type { ChainReader } from "./rpc";

/**
 * Addresses tokens are sent to so that nobody moves them again: the zero address, and the 0x…dEaD address
 * by convention. Shown as labeled rows, outside the top-ten share.
 */
export const BURN_ADDRESSES: readonly Address[] = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"];

export type HolderLabel = "creator" | "curve" | "pool" | "first-second" | "burn";

export const HOLDER_LABELS: Record<HolderLabel, string> = {
  creator: "Creator",
  curve: "Curve",
  pool: "Pool",
  "first-second": "First-second buyer",
  burn: "Burn",
};

export interface HolderRow {
  address: Address;
  balance: bigint;
  /** Of the total supply; null when the supply was not read. */
  share: number | null;
  labels: HolderLabel[];
}

export interface HolderScanInput {
  /** The token's total supply at the block the balances were read at. */
  supply: bigint | null;
  /** Blockscout's count of holders, or null. */
  holderCount: number | null;
  /** The largest holders in Blockscout's index, in its order; null when it was not read. */
  listed: readonly string[] | null;
  /** Balances read on-chain at one block, by lowercase address. An address missing here was not read. */
  balances: ReadonlyMap<string, bigint>;
  creator: string;
  curve: string;
  /** Uniswap V4's PoolManager, which holds every V4 pool's tokens; null when it was not read. */
  poolManager: string | null;
  /** Recipients of the curve's buys in the launch second; null when they were not read. */
  firstSecondBuyers: readonly string[] | null;
  /** Rows kept, largest first. Default 20. */
  limit?: number;
}

export interface HolderScan {
  holderCount: number | null;
  /** The ten largest holders outside the curve, the pool and the burn addresses. Null without the index's list. */
  top10: { wallets: number; balance: bigint; share: number | null } | null;
  creator: { balance: bigint | null; share: number | null };
  /** What the launch-second buyers hold now. Null when the buys were not read. */
  firstSecond: { wallets: number; holding: number; balance: bigint; share: number | null; includesCreator: boolean; unread: number } | null;
  /** The index's largest holders, re-ranked by their balance on-chain, with what each address is. */
  rows: HolderRow[];
}

/** `balance` as a fraction of `supply` (0.25 for a quarter), to a millionth; null without a supply. */
export function fractionOf(balance: bigint | null, supply: bigint | null): number | null {
  if (balance === null || supply === null || supply <= 0n) return null;
  return Number((balance * 1_000_000n) / supply) / 1_000_000;
}

const lower = (address: string) => address.toLowerCase();

/** The figures of a holder scan from what was read. */
export function computeHolderScan(input: HolderScanInput): HolderScan {
  const { supply, balances } = input;
  const creator = lower(input.creator);
  const curve = lower(input.curve);
  const pool = input.poolManager ? lower(input.poolManager) : null;
  const burns = new Set(BURN_ADDRESSES.map(lower));
  const buyers = input.firstSecondBuyers ? [...new Set(input.firstSecondBuyers.filter((address) => isAddress(address)).map(lower))] : null;
  const buyerSet = new Set(buyers ?? []);

  const labelsOf = (address: string): HolderLabel[] => {
    const labels: HolderLabel[] = [];
    if (address === creator) labels.push("creator");
    if (address === curve) labels.push("curve");
    if (pool && address === pool) labels.push("pool");
    if (burns.has(address)) labels.push("burn");
    if (buyerSet.has(address)) labels.push("first-second");
    return labels;
  };
  const outside = (labels: readonly HolderLabel[]) => labels.includes("curve") || labels.includes("pool") || labels.includes("burn");

  let rows: HolderRow[] = [];
  let top10: HolderScan["top10"] = null;
  if (input.listed) {
    const unique = [...new Set(input.listed.filter((address) => isAddress(address)).map(lower))];
    const ranked = unique
      .map((address) => ({ address, balance: balances.get(address) }))
      .filter((row): row is { address: string; balance: bigint } => row.balance !== undefined && row.balance > 0n)
      .sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1))
      .map((row) => ({ address: getAddress(row.address), balance: row.balance, share: fractionOf(row.balance, supply), labels: labelsOf(row.address) }));
    const wallets = ranked.filter((row) => !outside(row.labels)).slice(0, 10);
    const held = wallets.reduce((sum, row) => sum + row.balance, 0n);
    top10 = { wallets: wallets.length, balance: held, share: fractionOf(held, supply) };
    rows = ranked.slice(0, input.limit ?? 20);
  }

  const creatorBalance = balances.get(creator) ?? null;
  let firstSecond: HolderScan["firstSecond"] = null;
  if (buyers) {
    let balance = 0n;
    let holding = 0;
    let unread = 0;
    for (const buyer of buyers) {
      const value = balances.get(buyer);
      if (value === undefined) {
        unread += 1;
        continue;
      }
      balance += value;
      if (value > 0n) holding += 1;
    }
    firstSecond = { wallets: buyers.length, holding, balance, share: fractionOf(balance, supply), includesCreator: buyerSet.has(creator), unread };
  }

  return { holderCount: input.holderCount, top10, creator: { balance: creatorBalance, share: fractionOf(creatorBalance, supply) }, firstSecond, rows };
}

/**
 * The last block of the second `second`, from `fromBlock` on (block times never go back): a binary search
 * over block headers, at most `reach` blocks ahead. Robinhood Chain makes about ten blocks a second.
 */
export async function lastBlockOfSecond(reader: ChainReader, fromBlock: bigint, second: number, reach = 256n): Promise<bigint> {
  let low = fromBlock;
  let high = fromBlock + reach;
  const top = await reader.header(high).catch(() => null);
  if (top && top.timestamp <= second) return high;
  // Invariant: low's time is at most `second`; high's is later (or high is past the head).
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    const seen = await reader.header(middle).catch(() => null);
    if (seen && seen.timestamp <= second) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * The recipients of the curve's buys in its launch second: CurveBuy logs from the launch block to the last
 * block of the second the curve's launchedAt names.
 */
export async function readFirstSecondBuyers(
  reader: ChainReader,
  options: { curve: Address; launchBlock: bigint; launchedAt: number },
): Promise<{ buyers: Address[]; fromBlock: bigint; toBlock: bigint }> {
  const { curve, launchBlock, launchedAt } = options;
  const toBlock = await lastBlockOfSecond(reader, launchBlock, launchedAt);
  const logs = await reader.getLogs({ address: curve, topics: [[TOPICS.curveBuy]], fromBlock: launchBlock, toBlock });
  const buys = decodeTrades(logs.filter((log) => lower(log.address) === lower(curve))).filter((trade) => trade.side === "buy");
  return { buyers: [...new Map(buys.map((trade) => [lower(trade.trader), trade.trader])).values()], fromBlock: launchBlock, toBlock };
}

/**
 * Everything a holder scan reads on-chain, in one Multicall3 batch at one block: the total supply, the
 * factory's PoolManager, and the balance of each address given.
 */
export async function readHolderBalances(
  reader: ChainReader,
  options: { token: Address; addresses: readonly string[] },
): Promise<{ supply: bigint | null; poolManager: Address | null; balances: Map<string, bigint>; read: Snapshot }> {
  const addresses = [...new Set(options.addresses.filter((address) => isAddress(address)).map(lower))];
  const reads: Read[] = [
    { address: options.token, abi: ERC20_ABI, functionName: "totalSupply" },
    { address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: "poolManager" },
    ...addresses.map((address) => ({ address: options.token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }) as Read),
  ];
  const answer = await multicall(reader, reads);
  const [supply, manager, ...rest] = answer.results;
  const balances = new Map<string, bigint>();
  addresses.forEach((address, i) => {
    const result = rest[i];
    if (result?.ok && typeof result.value === "bigint") balances.set(address, result.value);
  });
  return {
    supply: supply?.ok && typeof supply.value === "bigint" ? supply.value : null,
    poolManager: manager?.ok && typeof manager.value === "string" && isAddress(manager.value) ? getAddress(manager.value) : null,
    balances,
    read: { block: answer.block, timestamp: answer.timestamp },
  };
}
