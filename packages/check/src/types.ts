/**
 * The public contract of Hyvo Check: what `checkToken` returns and accepts.
 *
 * A report states facts read from Robinhood Chain at one block, each with its evidence. Amounts are raw
 * integers in the token's or ETH's smallest unit (bigint); `serializeReport` turns them into decimal strings
 * for JSON.
 */

/** A 20-byte address, checksummed (EIP-55) wherever Hyvo Check produces one. */
export type Address = `0x${string}`;
/** Hex-encoded bytes with a 0x prefix. */
export type Hex = `0x${string}`;

/** The checks, in the order a report lists them. Ids are stable: programs key off them. */
export type CheckId =
  | "source"
  | "owner"
  | "proxy"
  | "mint"
  | "fee-setter"
  | "blocklist"
  | "pause"
  | "venue"
  | "sell-simulation"
  | "holders"
  | "deployer";

/**
 * `found`: the check found what it looks for (see `CHECKS[id].looksFor`). `not_found`: it looked and did not
 * find it; the evidence says where it looked. `skipped`: it could not look; the evidence says why.
 */
export type FindingStatus = "found" | "not_found" | "skipped";

/** One fact. Every finding carries non-empty evidence: a function, an address, a number or a reason. */
export interface Finding {
  id: CheckId;
  /** A short label, at most 40 characters, the same for every status. */
  title: string;
  status: FindingStatus;
  /** What was read and where, in plain words. Never empty. */
  evidence: string;
}

export interface TokenInfo {
  address: Address;
  /** Null when the token does not answer `name()`. Text from the token, cleaned of control characters. */
  name: string | null;
  symbol: string | null;
  /** Null when the token does not answer `decimals()`. */
  decimals: number | null;
  totalSupply: bigint | null;
}

/** Where the exit simulation trades the token: the first venue found, in this order. */
export type Venue =
  | {
      /** A Pons v2 launch still on its bonding curve, quoted in native ETH. */
      kind: "pons-curve";
      curve: Address;
      /** The curve's own fee, in basis points; null when it could not be read. */
      curveFeeBps: number | null;
      /** The creator tax set at launch, in basis points. Immutable on the curve. */
      creatorTaxBps: number;
      /** The snipe tax a fresh buyer would pay at this block, in basis points; null when unknown. */
      snipeTaxBpsNow: number | null;
    }
  | {
      /** A Pons v2 launch that graduated to a Uniswap V4 pool with the Pons hook. */
      kind: "pons-v4";
      poolManager: Address;
      hooks: Address;
      fee: number;
      tickSpacing: number;
      creatorTaxBps: number;
      /** The pool's other side: the zero address for native ETH, or WETH. */
      quote: Address;
    }
  | {
      /** A Uniswap V2 pair with WETH. */
      kind: "v2";
      router: Address;
      pair: Address;
    }
  | {
      /** A Uniswap V3 pool with WETH; the fee tier with the most in-range liquidity. */
      kind: "v3";
      router: Address;
      quoter: Address;
      pool: Address;
      /** The fee tier in hundredths of a basis point, e.g. 10000 for 1%. */
      fee: number;
    };

export interface Step {
  /** The call went through. */
  ok: boolean;
  /**
   * What the venue's own math promised before the step, after the venue's published fees and taxes
   * (tokens for a buy, ETH or WETH for a sell), or what was sent for a transfer. Null when the venue gave
   * no quote.
   */
  promised: bigint | null;
  /** What actually arrived. */
  arrived: bigint;
  /**
   * How much less arrived than promised, in percent; negative when more arrived than promised, null
   * without a promise.
   */
  shortfallPct: number | null;
  /** Gas the step used inside the simulation; null for the transfer, which the probe does not meter. */
  gas: bigint | null;
  /** The decoded revert reason when the step failed, such as `Error("TransferHelper: TRANSFER_FROM_FAILED")`. */
  reason: string | null;
}

/**
 * One buy, a transfer of a tenth of what arrived to a fresh address, and a sell of the rest, all inside a
 * single read-only `eth_call` at `block`. Nothing is signed or sent.
 */
export interface ExitSimulation {
  venue: Venue;
  /** The ETH the probe spent on the buy. */
  ethIn: bigint;
  /** What the sell paid out: native ETH, or WETH (Uniswap V3, and V4 pools quoted in WETH). */
  payout: "eth" | "weth";
  buy: Step;
  /** Null when the buy did not deliver any tokens, so nothing was sent or sold. */
  transfer: Step | null;
  sell: Step | null;
  /**
   * The cost of buying and selling straight back, fees and taxes together, for the part that was sold:
   * the ETH the sold tokens cost at the buy's average price, the ETH or WETH that came back, and the loss in
   * percent. In a very shallow pool the buy itself moves the price, and the loss can come out negative.
   * Null when the sell did not go through.
   */
  roundTrip: { spent: bigint; back: bigint; lossPct: number } | null;
}

export interface CodeFacts {
  /** Size of the token's runtime code, in bytes. */
  bytes: number;
  /** The implementation the token runs when it is a proxy (EIP-1967, beacon or EIP-1167); null otherwise. */
  proxyImplementation: Address | null;
  /** What `owner()` (or `getOwner()`) returns, when the token has one. */
  owner: Address | null;
  /** True when `owner()` exists and returns the zero address. */
  ownerRenounced: boolean;
  /** Whether Sourcify holds verified source: "full", "partial", "none", or "unknown" when it could not be asked. */
  sourcify: "full" | "partial" | "none" | "unknown";
}

export interface Timings {
  /** Wall-clock time of the whole check. Phases overlap, so they do not add up to it. */
  totalMs: number;
  /** Until the reads before the simulation had answered: chain id, head, code, proxy slots and three multicalls. */
  chainMs: number;
  /** The exit simulation's eth_call; null when it did not run. */
  simulationMs: number | null;
  /** Until Sourcify (and Blockscout, with a key) had answered. */
  sourcesMs: number;
  /** HTTP requests made, by destination. A Cloudflare Worker counts each one as a subrequest. */
  requests: { rpc: number; sourcify: number; blockscout: number };
}

export interface CheckReport {
  chainId: number;
  token: TokenInfo;
  /** The block every read and the simulation ran at. */
  block: bigint;
  findings: Finding[];
  /** Null when no venue that Hyvo Check can trade was found, or the simulation could not run. */
  exit: ExitSimulation | null;
  code: CodeFacts;
  timings: Timings;
  /** The line every surface showing this report should carry. */
  notice: string;
}

/**
 * What an index of the chain says about a token's holders and creator, read apart from the check: Hyvo's API
 * reads Blockscout's index with its own key and hands these out, and `checkToken` takes them through
 * `options.holders`. They are the index's, not read at the check's block, and the evidence says where they
 * came from (`source`).
 */
export interface HolderFacts {
  /**
   * Where and when the facts were read, as the evidence names it, such as "Blockscout's index, read through
   * Hyvo's API at 07:12 UTC on 2026-11-09".
   */
  source: string;
  /** The index's total supply; the check's own read at its block comes first. */
  totalSupply: bigint | null;
  /** How many addresses hold the token, by the index's count. */
  holderCount: number | null;
  /** The largest holders, largest first (the index's first page); null when they could not be read. */
  holders: { address: Address; value: bigint }[] | null;
  /** Why `holders` is null, in plain words; null when they were read. */
  holdersMissing: string | null;
  /** Who created the token, by the index; null when it does not say or could not be read. */
  creator: { address: Address; creationTxHash: Hex | null } | null;
  /** Why `creator` is null, in plain words; null when it was read. */
  creatorMissing: string | null;
}

/** The structural minimum of `fetch` that Hyvo Check uses, so browser, Node and Worker fetch all fit. */
export type FetchLike = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export interface CheckOptions {
  /** JSON-RPC endpoints for Robinhood Chain, tried in order. Default `["https://robinhood.drpc.org"]`. */
  rpcUrls?: string[];
  /** Default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Aborts every request of the check; `checkToken` then rejects with a CheckError `aborted`. */
  signal?: AbortSignal;
  /** Sourcify server. Default `https://sourcify.dev/server`. */
  sourcifyUrl?: string;
  /**
   * A Blockscout API key (free at dev.blockscout.com). Without one, the holder check is skipped and Sourcify
   * alone answers for verified source and the deployer.
   */
  blockscoutKey?: string;
  /** Blockscout's keyed API for chain 4663. Default `https://api.blockscout.com/4663/api`. */
  blockscoutUrl?: string;
  /**
   * Holders and the creator read elsewhere, such as through Hyvo's API (`GET /v1/check/:token/holders`). Called
   * once, as the check starts, and awaited with the other sources; it takes the place of Blockscout's holder and
   * creator reads. Null, or a rejection, leaves the holder check skipped.
   */
  holders?: (token: Address, signal?: AbortSignal) => Promise<HolderFacts | null>;
  /** ETH the exit simulation spends on the buy, in wei. Default 0.001 ETH (10^15 wei). */
  ethIn?: bigint;
  /** The block to read at. Default: two blocks below the head, so every RPC node has it. */
  block?: bigint;
  /** Time limit for each request, in milliseconds. Default 10 000. */
  timeoutMs?: number;
}

export type CheckErrorCode = "invalid_address" | "wrong_chain" | "rpc" | "not_a_contract" | "not_a_token" | "aborted";

/** Why a check could not be made at all (as opposed to a step reverting, which is a result). */
export class CheckError extends Error {
  override readonly name = "CheckError";

  constructor(
    readonly code: CheckErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}
