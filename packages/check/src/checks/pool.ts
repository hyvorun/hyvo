// Venue discovery: where a token trades against ETH, read from the launchpad and the factories in three batched
// waves. Order: a Pons v2 launch (its curve while phase 0, its Uniswap V4 pool with the Pons hook once
// graduated), else a Uniswap V2 pair with WETH that holds reserves, else the Uniswap V3 pool with WETH that has
// the most in-range liquidity. A Uniswap V4 pool outside Pons is reported, and not simulated yet.
//
// Factory addresses are read from the routers on-chain (Router02.factory(), SwapRouter02.factory()), and the
// Pons hook and PoolManager from the Pons v2 factory (memeHook(), poolManager()), on every check.

import { ZERO_ADDRESS, addressWord, decodeAddress, funcSelector, sameAddress, shortenAddress, uintWord } from "../chain/abi.js";
import { type AbiParam } from "../chain/abi-encode.js";
import { decodeParameters } from "../chain/abi-decode.js";
import type { Read } from "../chain/multicall.js";
import { balanceOfRead, uintOrNull } from "../chain/token.js";
import { formatAmount, formatPct } from "../chain/units.js";
import { makeFinding } from "../output/finding.js";
import { ADDRESSES, BURN_ADDRESSES, PROBE_ADDRESS } from "../registry/addresses.js";
import { PONS_V1, PONS_V2 } from "../registry/launchpads.js";
import type { Address, Finding, Venue } from "../types.js";
import { CHECKS } from "./catalog.js";

const WETH = ADDRESSES.weth.address;
const USDG = ADDRESSES.usdg.address;
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

const PONS_V2_LAUNCH: AbiParam[] = [
  {
    type: "tuple",
    components: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" },
      { name: "deployer", type: "address" },
      { name: "creatorFeeRecipient", type: "address" },
      { name: "pairToken", type: "address" },
      { name: "graduationThreshold", type: "uint256" },
      { name: "poolFee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "creatorTaxBps", type: "uint16" },
      { name: "buybackEnabled", type: "bool" },
      { name: "phase", type: "uint8" },
      { name: "sweptQuote", type: "uint256" },
      { name: "sweptTokens", type: "uint256" },
      { name: "sweptAt", type: "uint256" },
      { name: "exists", type: "bool" },
    ],
  },
];

const PONS_V1_LAUNCH: AbiParam[] = [
  {
    type: "tuple",
    components: [
      { name: "token", type: "address" },
      { name: "deployer", type: "address" },
      { name: "pairedToken", type: "address" },
      { name: "positionManager", type: "address" },
      { name: "positionId", type: "uint256" },
      { name: "dexId", type: "uint256" },
      { name: "launchConfigId", type: "uint256" },
      { name: "restrictionsEndBlock", type: "uint256" },
      { name: "supply", type: "uint256" },
      { name: "isToken0", type: "bool" },
      { name: "poolFee", type: "uint24" },
      { name: "exists", type: "bool" },
      { name: "initialBuyAmount", type: "uint256" },
    ],
  },
];

/** Pons v2 graduation phases (GraduationPhase in PonsV2LaunchFactory). */
export const PONS_PHASES = ["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const;

export interface PonsV2Launch {
  curve: Address;
  launcher: Address;
  pairToken: Address;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  phase: number;
}

export interface DiscoveryA {
  ponsV2: PonsV2Launch | null;
  ponsV1: { launcher: Address; pairedToken: Address; poolFee: number } | null;
  v2Factory: Address | null;
  v3Factory: Address | null;
  ponsHook: Address | null;
  ponsPoolManager: Address | null;
  /** The token balance of Uniswap's V4 PoolManager, which holds every V4 pool's liquidity. */
  poolManagerBalance: bigint | null;
}

export interface DiscoveryB {
  v2Pair: Address | null;
  v3Pools: { fee: number; pool: Address }[];
  curveRates: { feeBps: number | null; creatorTaxBps: number | null; snipeTaxBpsNow: number | null } | null;
}

export interface DiscoveryC {
  v2Reserves: { weth: bigint; token: bigint } | null;
  v3: { fee: number; pool: Address; liquidity: bigint | null; weth: bigint | null }[];
}

const call = (target: string, signature: string, words = ""): Read => ({ target, data: funcSelector(signature) + words });

function addressOrNull(raw: string | null | undefined): Address | null {
  if (!raw || raw.length < 66) return null;
  const a = decodeAddress(raw);
  return a === ZERO_ADDRESS ? null : a;
}

function smallInt(raw: string | null | undefined): number | null {
  const v = uintOrNull(raw ?? null);
  return v !== null && v <= 1_000_000n ? Number(v) : null;
}

export function discoveryReadsA(token: Address): Read[] {
  return [
    call(PONS_V2.factory, "getLaunchedToken(address)", addressWord(token)),
    call(PONS_V1.factory, "getLaunchedToken(address)", addressWord(token)),
    call(ADDRESSES.uniswapV2Router02.address, "factory()"),
    call(ADDRESSES.uniswapV3SwapRouter02.address, "factory()"),
    call(PONS_V2.factory, "memeHook()"),
    call(PONS_V2.factory, "poolManager()"),
    balanceOfRead(token, ADDRESSES.uniswapV4PoolManager.address),
  ];
}

export function parseDiscoveryA(answers: readonly (string | null)[]): DiscoveryA {
  const [v2Launch, v1Launch, v2Factory, v3Factory, hook, pm, pmBalance] = answers;
  let ponsV2: PonsV2Launch | null = null;
  if (v2Launch) {
    try {
      const [l] = decodeParameters(PONS_V2_LAUNCH, v2Launch) as [Record<string, unknown>];
      if (l.exists === true) {
        ponsV2 = {
          curve: l.curve as Address,
          launcher: l.deployer as Address,
          pairToken: l.pairToken as Address,
          poolFee: Number(l.poolFee as bigint),
          tickSpacing: Number(l.tickSpacing as bigint),
          creatorTaxBps: Number(l.creatorTaxBps as bigint),
          phase: Number(l.phase as bigint),
        };
      }
    } catch {
      ponsV2 = null;
    }
  }
  let ponsV1: DiscoveryA["ponsV1"] = null;
  if (v1Launch) {
    try {
      const [l] = decodeParameters(PONS_V1_LAUNCH, v1Launch) as [Record<string, unknown>];
      if (l.exists === true) {
        ponsV1 = { launcher: l.deployer as Address, pairedToken: l.pairedToken as Address, poolFee: Number(l.poolFee as bigint) };
      }
    } catch {
      ponsV1 = null;
    }
  }
  return {
    ponsV2,
    ponsV1,
    v2Factory: addressOrNull(v2Factory),
    v3Factory: addressOrNull(v3Factory),
    ponsHook: addressOrNull(hook),
    ponsPoolManager: addressOrNull(pm),
    poolManagerBalance: uintOrNull(pmBalance ?? null),
  };
}

export function discoveryReadsB(token: Address, a: DiscoveryA): { reads: Read[]; parse: (answers: readonly (string | null)[]) => DiscoveryB } {
  const reads: Read[] = [];
  const pairAt = a.v2Factory ? reads.push(call(a.v2Factory, "getPair(address,address)", addressWord(token) + addressWord(WETH))) - 1 : -1;
  const poolsAt = a.v3Factory
    ? V3_FEE_TIERS.map(
        (fee) =>
          reads.push(call(a.v3Factory!, "getPool(address,address,uint24)", addressWord(token) + addressWord(WETH) + uintWord(BigInt(fee)))) - 1,
      )
    : [];
  const curve = a.ponsV2 && a.ponsV2.phase === 0 ? a.ponsV2.curve : null;
  const ratesAt = curve
    ? [
        reads.push(call(curve, "feeBps()")) - 1,
        reads.push(call(curve, "creatorTaxBps()")) - 1,
        reads.push(call(curve, "currentSnipeTaxBps(address)", addressWord(PROBE_ADDRESS))) - 1,
      ]
    : null;
  return {
    reads,
    parse: (answers) => ({
      v2Pair: pairAt >= 0 ? addressOrNull(answers[pairAt]) : null,
      v3Pools: poolsAt
        .map((at, i): { fee: number; pool: Address | null } => ({ fee: V3_FEE_TIERS[i]!, pool: addressOrNull(answers[at]) }))
        .filter((p): p is { fee: number; pool: Address } => p.pool !== null),
      curveRates: ratesAt
        ? { feeBps: smallInt(answers[ratesAt[0]!]), creatorTaxBps: smallInt(answers[ratesAt[1]!]), snipeTaxBpsNow: smallInt(answers[ratesAt[2]!]) }
        : null,
    }),
  };
}

export function discoveryReadsC(token: Address, b: DiscoveryB): { reads: Read[]; parse: (answers: readonly (string | null)[]) => DiscoveryC } {
  const reads: Read[] = [];
  const pairAt = b.v2Pair
    ? [reads.push(call(b.v2Pair, "getReserves()")) - 1, reads.push(call(b.v2Pair, "token0()")) - 1]
    : null;
  const poolsAt = b.v3Pools.map((p) => [reads.push(call(p.pool, "liquidity()")) - 1, reads.push(balanceOfRead(WETH, p.pool)) - 1] as const);
  return {
    reads,
    parse: (answers) => {
      let v2Reserves: DiscoveryC["v2Reserves"] = null;
      if (pairAt) {
        const reserves = answers[pairAt[0]!];
        const token0 = addressOrNull(answers[pairAt[1]!]);
        if (reserves && reserves.length >= 130 && token0) {
          try {
            const [r0, r1] = decodeParameters([{ type: "uint112" }, { type: "uint112" }], reserves.slice(0, 130)) as [bigint, bigint];
            v2Reserves = sameAddress(token0, token) ? { token: r0, weth: r1 } : { token: r1, weth: r0 };
          } catch {
            v2Reserves = null;
          }
        }
      }
      return {
        v2Reserves,
        v3: b.v3Pools.map((p, i) => ({
          ...p,
          liquidity: uintOrNull(answers[poolsAt[i]![0]] ?? null),
          weth: uintOrNull(answers[poolsAt[i]![1]] ?? null),
        })),
      };
    },
  };
}

export type VenueChoice = {
  /** The venue the exit simulation trades through; null when there is none it covers. */
  venue: Venue | null;
  finding: Finding;
  /** Why there is no simulation, when `venue` is null. */
  uncovered: string | null;
  /** Addresses whose balances are pool liquidity, not a holder's, for the holder check. */
  excluded: { address: Address; label: string }[];
};

function feeTier(fee: number): string {
  return formatPct(fee / 10_000);
}

function quoteName(quote: Address): string {
  if (quote === ZERO_ADDRESS) return "native ETH";
  if (sameAddress(quote, WETH)) return `WETH (${shortenAddress(WETH)})`;
  if (sameAddress(quote, USDG)) return `USDG (${shortenAddress(USDG)})`;
  return shortenAddress(quote);
}

export function chooseVenue(token: Address, decimals: number | null, a: DiscoveryA, b: DiscoveryB, c: DiscoveryC): VenueChoice {
  const title = CHECKS.venue.title;
  const dec = decimals ?? 18;
  const excluded: VenueChoice["excluded"] = BURN_ADDRESSES.map((address) => ({ address, label: "burn addresses" }));
  excluded.push({ address: ADDRESSES.uniswapV4PoolManager.address, label: "the Uniswap V4 PoolManager" });
  const found = (evidence: string, venue: Venue | null, uncovered: string | null = null): VenueChoice => ({
    venue,
    uncovered,
    excluded,
    finding: makeFinding({ id: "venue", title, status: "found", evidence }),
  });

  // Only the pools this check discovers: with WETH. A pair or pool with another asset, such as USDG, stays in.
  if (a.ponsV2) excluded.push({ address: a.ponsV2.curve, label: "the Pons curve" });
  if (b.v2Pair) excluded.push({ address: b.v2Pair, label: "the Uniswap V2 pair with WETH" });
  for (const p of b.v3Pools) excluded.push({ address: p.pool, label: "the Uniswap V3 pools with WETH" });

  // 1. Pons v2
  const pons = a.ponsV2;
  let ponsNote: string | null = null;
  if (pons) {
    const ethQuoted = pons.pairToken === ZERO_ADDRESS;
    const wethQuoted = sameAddress(pons.pairToken, WETH);
    if (pons.phase === 0) {
      const rates = b.curveRates;
      const text = `the Pons v2 bonding curve ${shortenAddress(pons.curve)}, quoted in ${quoteName(pons.pairToken)}: curve fee ${
        rates?.feeBps != null ? formatPct(rates.feeBps / 100) : "unknown"
      }, creator tax ${formatPct(pons.creatorTaxBps / 100)}, snipe tax at this block ${
        rates?.snipeTaxBpsNow != null ? formatPct(rates.snipeTaxBpsNow / 100) : "unknown"
      }`;
      if (ethQuoted) {
        return found(text, {
          kind: "pons-curve",
          curve: pons.curve,
          curveFeeBps: rates?.feeBps ?? null,
          creatorTaxBps: pons.creatorTaxBps,
          snipeTaxBpsNow: rates?.snipeTaxBpsNow ?? null,
        });
      }
      ponsNote = `${text}; the exit simulation buys with ETH, and this curve takes ${quoteName(pons.pairToken)}`;
    } else if (pons.phase === 2) {
      if (!a.ponsHook || !a.ponsPoolManager) {
        ponsNote = "a graduated Pons v2 launch, but the Pons factory did not name its hook and PoolManager";
      } else {
        const text = `a Uniswap V4 pool with the Pons hook ${shortenAddress(a.ponsHook)}, quoted in ${quoteName(pons.pairToken)}, fee ${pons.poolFee}, tick spacing ${pons.tickSpacing}: the Pons v2 launch graduated (creator tax ${formatPct(pons.creatorTaxBps / 100)})`;
        if (ethQuoted || wethQuoted) {
          return found(text, {
            kind: "pons-v4",
            poolManager: a.ponsPoolManager,
            hooks: a.ponsHook,
            fee: pons.poolFee,
            tickSpacing: pons.tickSpacing,
            creatorTaxBps: pons.creatorTaxBps,
            quote: pons.pairToken,
          });
        }
        ponsNote = `${text}; the exit simulation buys with ETH, and this pool takes ${quoteName(pons.pairToken)}`;
      }
    } else {
      ponsNote = `a Pons v2 launch in phase ${PONS_PHASES[pons.phase] ?? pons.phase}: off its curve and without a V4 pool to trade`;
    }
  }

  // 2. Uniswap V2 pair with WETH that holds reserves
  if (b.v2Pair && c.v2Reserves && c.v2Reserves.weth > 0n && c.v2Reserves.token > 0n) {
    const text = `the Uniswap V2 pair ${shortenAddress(b.v2Pair)} with WETH, holding ${formatAmount(c.v2Reserves.weth, 18)} WETH and ${formatAmount(c.v2Reserves.token, dec)} tokens`;
    return found(ponsNote ? `${text}; also ${ponsNote}` : text, { kind: "v2", router: ADDRESSES.uniswapV2Router02.address, pair: b.v2Pair });
  }

  // 3. Uniswap V3 pool with WETH: the most in-range liquidity, then the most WETH
  const pools = c.v3
    .filter((p) => (p.liquidity ?? 0n) > 0n || (p.weth ?? 0n) > 0n)
    .sort((x, y) => {
      const lx = x.liquidity ?? 0n;
      const ly = y.liquidity ?? 0n;
      if (lx !== ly) return ly > lx ? 1 : -1;
      const wx = x.weth ?? 0n;
      const wy = y.weth ?? 0n;
      return wy > wx ? 1 : wy < wx ? -1 : 0;
    });
  const best = pools[0];
  if (best) {
    const others = pools.length > 1 ? `; ${pools.length - 1} other fee tier(s) hold less` : "";
    const text = `the Uniswap V3 pool ${shortenAddress(best.pool)} with WETH at the ${feeTier(best.fee)} fee tier, in-range liquidity ${
      best.liquidity ?? "unknown"
    }, holding ${best.weth !== null ? `${formatAmount(best.weth, 18)} WETH` : "an unknown amount of WETH"}${others}`;
    return found(ponsNote ? `${text}; also ${ponsNote}` : text, {
      kind: "v3",
      router: ADDRESSES.uniswapV3SwapRouter02.address,
      quoter: ADDRESSES.uniswapV3QuoterV2.address,
      pool: best.pool,
      fee: best.fee,
    });
  }

  if (ponsNote) return found(ponsNote, null, ponsNote);

  // 4. A V4 pool outside Pons: the PoolManager holds the token, but the pool key is not known here.
  if (a.poolManagerBalance !== null && a.poolManagerBalance > 0n) {
    const text = `the Uniswap V4 PoolManager ${shortenAddress(ADDRESSES.uniswapV4PoolManager.address)} holds ${formatAmount(a.poolManagerBalance, dec)} tokens, so a V4 pool outside Pons trades it`;
    return found(text, null, "V4 pools outside Pons are not covered by the exit simulation yet");
  }

  // Nothing with liquidity. Pools that exist but hold nothing are named, so "not found" is not mistaken for "never made".
  const v2 = !b.v2Pair
    ? "no Uniswap V2 pair with WETH"
    : c.v2Reserves
      ? `the Uniswap V2 pair ${shortenAddress(b.v2Pair)} with WETH holds no reserves`
      : `the Uniswap V2 pair ${shortenAddress(b.v2Pair)} with WETH did not report its reserves`;
  const v3 =
    c.v3.length > 0
      ? c.v3
          .map((p) =>
            p.liquidity === null || p.weth === null
              ? `the Uniswap V3 pool ${shortenAddress(p.pool)} (${feeTier(p.fee)}) did not report its liquidity`
              : `the Uniswap V3 pool ${shortenAddress(p.pool)} (${feeTier(p.fee)}) holds no WETH and no in-range liquidity`,
          )
          .join(", ")
      : `no Uniswap V3 pool with WETH at the ${V3_FEE_TIERS.map(feeTier).join(", ")} fee tiers`;
  const ponsV1 = a.ponsV1 ? "; a Pons v1 launch record exists" : "";
  const pm = a.poolManagerBalance === null ? "an unknown amount" : "none";
  const evidence = `no Pons v2 launch record, ${v2}, ${v3}, and the Uniswap V4 PoolManager holds ${pm} of it${ponsV1}`;
  return {
    venue: null,
    uncovered: b.v2Pair || c.v3.length > 0 ? "the token's pools hold no liquidity to trade against" : "no venue was found",
    excluded,
    finding: makeFinding({ id: "venue", title, status: "not_found", evidence }),
  };
}
