// checkToken: every check for one token, read at one block, in a few batched waves:
//
//   0. eth_chainId and eth_blockNumber; the block is pinned two below the head.
//   1. the token's code, its two EIP-1967 slots, and a multicall: name, symbol, decimals, totalSupply, owner(),
//      getOwner(), both Pons factories' records, the routers' factories, the Pons hook and PoolManager, and the
//      PoolManager's balance of the token. Sourcify (and Blockscout, with a key) start beside it.
//   2. a multicall: the V2 pair and V3 pools from the factories, the Pons curve's rates, a beacon's
//      implementation; and the implementation's code when the token is a proxy.
//   3. a multicall: the pair's reserves and the pools' liquidity.
//   4. the exit simulation: one eth_call with the probe placed by a state override.
//
// Read-only throughout: nothing is signed, approved or sent, and no key is ever involved.

import { SELECTORS, ZERO_ADDRESS, decodeUint, isAddress, strip0x, toChecksumAddress } from "./chain/abi.js";
import { readChainId } from "./chain/assert.js";
import { type BlockscoutContract, BlockscoutClient } from "./chain/blockscout.js";
import { DEFAULT_ETH_IN, DEFAULT_TIMEOUT_MS, HEAD_MARGIN, ROBINHOOD_CHAIN } from "./chain/config.js";
import { multicall } from "./chain/multicall.js";
import { JsonRpcClient, RpcError, toBlockTag, toRpcError } from "./chain/rpc.js";
import { type SourcifyContract, SourcifyClient } from "./chain/sourcify.js";
import { parseToken, tokenReads } from "./chain/token.js";
import { blacklistCheck } from "./checks/blacklist.js";
import type { CheckContext, CodeTarget } from "./checks/context.js";
import { holdersCheck } from "./checks/holders.js";
import { mintCheck } from "./checks/mint.js";
import { mutableFeeCheck } from "./checks/mutable-fee.js";
import { originCheck } from "./checks/origin.js";
import { ownerReads, ownershipCheck, parseOwner } from "./checks/ownership.js";
import { pausableCheck } from "./checks/pausable.js";
import {
  chooseVenue,
  type DiscoveryC,
  discoveryReadsA,
  discoveryReadsB,
  discoveryReadsC,
  parseDiscoveryA,
  type VenueChoice,
} from "./checks/pool.js";
import { type ProxyInfo, proxyCheck, readProxy, SLOT_BEACON, SLOT_IMPLEMENTATION, UPGRADE } from "./checks/proxy.js";
import { detectFunctions } from "./checks/detect.js";
import { buildExit, runProbe, sellSimulationFinding } from "./checks/sell-simulation.js";
import { verifiedCheck } from "./checks/verified.js";
import { HttpError, Net } from "./net.js";
import { validateFindings } from "./output/finding.js";
import { PONS_V1, PONS_V2 } from "./registry/launchpads.js";
import {
  type Address,
  type CheckOptions,
  type CheckReport,
  CheckError,
  type ExitSimulation,
  type FetchLike,
  type Finding,
  type Hex,
  type HolderFacts,
} from "./types.js";

/** The line every surface that shows a report should carry with it. */
export const CHECK_NOTICE =
  "Facts read from Robinhood Chain at one block, each with its evidence. Not a trading signal, and not an audit.";

function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: RpcError }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: toRpcError(error) }),
  );
}

/**
 * Checks one token on Robinhood Chain and returns one report: the token, the block it read at, every finding
 * with its evidence, the exit simulation (or null), and timings. Throws a CheckError only when no report can be
 * made at all (not an address, the wrong chain, the RPC down, no contract, not a token, aborted).
 */
export async function checkToken(address: string, options: CheckOptions = {}): Promise<CheckReport> {
  const started = Date.now();
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (!isAddress(trimmed)) {
    throw new CheckError("invalid_address", `not an address: ${String(address).slice(0, 64)} (expected 0x and 40 hex characters)`);
  }
  const ethIn = options.ethIn ?? DEFAULT_ETH_IN;
  if (ethIn <= 0n || ethIn > 10n ** 21n) throw new RangeError("ethIn must be between 1 wei and 1000 ETH");
  const fetchFn = options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
  if (!fetchFn) throw new Error("no fetch in this environment: pass options.fetch");

  const net = new Net({ fetch: fetchFn, signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const rpcUrls = options.rpcUrls && options.rpcUrls.length > 0 ? options.rpcUrls : [...ROBINHOOD_CHAIN.rpcUrls];
  const rpc = new JsonRpcClient(net, rpcUrls);
  const sourcify = new SourcifyClient(net, options.sourcifyUrl ?? ROBINHOOD_CHAIN.sourcifyUrl, ROBINHOOD_CHAIN.chainId);
  const blockscout = options.blockscoutKey
    ? new BlockscoutClient(net, options.blockscoutUrl ?? ROBINHOOD_CHAIN.blockscoutApiUrl, options.blockscoutKey)
    : null;

  const holders = options.holders
    ? (token: Address): Promise<HolderFacts | null> => {
        try {
          return options.holders!(token, options.signal).then(
            (facts) => facts ?? null,
            () => null,
          );
        } catch {
          return Promise.resolve(null);
        }
      }
    : null;

  try {
    const report = await run(toChecksumAddress(trimmed), { net, rpc, sourcify, blockscout, holders, ethIn, started, block: options.block });
    if (net.aborted) throw new CheckError("aborted", "the check was aborted");
    return report;
  } catch (error) {
    if (error instanceof CheckError) throw error;
    if (net.aborted || (error instanceof RpcError && error.kind === "aborted") || (error instanceof HttpError && error.kind === "aborted")) {
      throw new CheckError("aborted", "the check was aborted");
    }
    if (error instanceof RpcError || error instanceof HttpError) {
      throw new CheckError("rpc", `Robinhood Chain could not be read: ${error.message}`, error.message);
    }
    throw error;
  }
}

interface RunContext {
  net: Net;
  rpc: JsonRpcClient;
  sourcify: SourcifyClient;
  blockscout: BlockscoutClient | null;
  /** `options.holders`, made never to reject; null without it. */
  holders: ((token: Address) => Promise<HolderFacts | null>) | null;
  ethIn: bigint;
  started: number;
  block: bigint | undefined;
}

async function run(token: Address, c: RunContext): Promise<CheckReport> {
  const { rpc, net } = c;

  // 0. The chain, and the block every read uses.
  const [chainId, head] = await Promise.all([readChainId(rpc), rpc.blockNumber().then(decodeUint)]);
  if (chainId !== ROBINHOOD_CHAIN.chainId) {
    throw new CheckError("wrong_chain", `the RPC answers for chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN.chainId})`);
  }
  const block = c.block ?? head - HEAD_MARGIN;
  const tag = toBlockTag(block);

  // Sources run beside the chain reads.
  const sourcesStarted = Date.now();
  const sourcifyToken = c.sourcify.contract(token);
  const bs = c.blockscout;
  // Holder facts from elsewhere take the place of Blockscout's holder and creator reads.
  const holderFacts = c.holders ? c.holders(token) : null;
  const blockscoutToken = bs
    ? Promise.all([
        bs.getContract(token),
        holderFacts ? null : bs.getTokenInfo(token),
        holderFacts ? null : bs.getTokenHolders(token),
        holderFacts ? null : bs.getCreator(token),
      ])
    : null;

  // 1. Code, proxy slots, and the first batch.
  const readsA = [...tokenReads(token), ...ownerReads(token), ...discoveryReadsA(token)];
  const [code, slots, answersA] = await Promise.all([
    rpc.getCode(token, tag),
    settle(Promise.all([rpc.getStorageAt(token, SLOT_IMPLEMENTATION, tag), rpc.getStorageAt(token, SLOT_BEACON, tag)])),
    multicall(rpc, tag, readsA),
  ]);
  if (strip0x(code).length === 0) {
    throw new CheckError("not_a_contract", `${token} has no code at block ${block}: it is not a contract`);
  }
  const tokenInfo = parseToken(token, answersA.slice(0, 4));
  const owner = parseOwner(answersA[4] ?? null, answersA[5] ?? null);
  const discA = parseDiscoveryA(answersA.slice(6));
  if (tokenInfo.totalSupply === null && discA.poolManagerBalance === null) {
    throw new CheckError("not_a_token", `${token} answers neither totalSupply() nor balanceOf(address): it is not an ERC-20 token`);
  }

  let proxy: ProxyInfo | null = slots.ok ? readProxy(code, slots.value[0], slots.value[1]) : null;
  const proxyFailure = slots.ok ? undefined : slots.error.message;

  // 2. Venue reads from the factories, a beacon's implementation, and the implementation's code.
  const stepB = discoveryReadsB(token, discA);
  const beaconAt = proxy?.kind === "beacon" ? stepB.reads.length : -1;
  const readsB = proxy?.kind === "beacon" ? [...stepB.reads, { target: proxy.beacon, data: SELECTORS.implementation }] : stepB.reads;
  const knownImpl = proxy && (proxy.kind === "eip1167" || proxy.kind === "eip1967") ? proxy.implementation : null;
  const implLookup = (impl: Address) =>
    Promise.all([
      settle(rpc.getCode(impl, tag)),
      c.sourcify.contract(impl),
      bs ? bs.getContract(impl) : Promise.resolve(undefined as BlockscoutContract | null | undefined),
    ]);
  const [answersB, implEarly] = await Promise.all([
    multicall(rpc, tag, readsB),
    knownImpl ? implLookup(knownImpl) : Promise.resolve(null),
  ]);
  const discB = stepB.parse(answersB);
  let implementation: Address | null = knownImpl;
  let implData = implEarly;
  if (proxy?.kind === "beacon") {
    const raw = answersB[beaconAt];
    const impl = raw && strip0x(raw).length >= 64 ? toChecksumAddress(`0x${strip0x(raw).slice(24, 64)}`) : null;
    proxy = { ...proxy, implementation: impl && impl !== ZERO_ADDRESS ? impl : null };
    implementation = proxy.implementation;
  }

  // 3. Reserves and liquidity, and a beacon implementation's code.
  const stepC = discoveryReadsC(token, discB);
  const [answersC, implLate] = await Promise.all([
    stepC.reads.length > 0 ? multicall(rpc, tag, stepC.reads) : Promise.resolve([]),
    implementation && !implData ? implLookup(implementation) : Promise.resolve(null),
  ]);
  if (implLate) implData = implLate;
  const discC: DiscoveryC = stepC.parse(answersC);
  const chainDone = Date.now();

  const venue: VenueChoice = chooseVenue(token, tokenInfo.decimals, discA, discB, discC);

  // 4. The exit simulation.
  let exit: ExitSimulation | null = null;
  let skip: string | null = venue.uncovered;
  let simulationMs: number | null = null;
  if (venue.venue) {
    const simStarted = Date.now();
    const outcome = await runProbe(rpc, tag, token, venue.venue, c.ethIn);
    simulationMs = Date.now() - simStarted;
    if ("result" in outcome) exit = buildExit(venue.venue, c.ethIn, outcome.result);
    else skip = outcome.error;
  }

  // Sources.
  const [sourcifyTokenResult, blockscoutResult, facts] = await Promise.all([sourcifyToken, blockscoutToken, holderFacts]);
  const sourcesDone = Date.now();
  const [bsContract, bsTokenInfo, bsHolders, bsCreator] = blockscoutResult ?? [undefined, undefined, undefined, undefined];
  const viaFacts = holderFacts !== null;

  // Where the token's logic lives, for the function checks.
  let codeTarget: CodeTarget | null = null;
  let codeMissing: string | undefined;
  const abiFrom = (s: SourcifyContract | null, b: BlockscoutContract | null | undefined) =>
    s?.abi ? { abi: s.abi, abiSource: "Sourcify" as const } : b?.abi ? { abi: b.abi, abiSource: "Blockscout" as const } : { abi: null, abiSource: null };
  if (!proxy || proxy.kind === "none") {
    codeTarget = { address: token, bytecode: code as Hex, ...abiFrom(sourcifyTokenResult, bsContract), via: "token" };
  } else if (!implementation) {
    codeMissing = "the beacon's implementation() does not answer, so the code that runs could not be read";
  } else if (!implData || !implData[0].ok || strip0x(implData[0].value).length === 0) {
    codeMissing = `the implementation ${implementation} has no code that could be read`;
  } else {
    codeTarget = {
      address: implementation,
      bytecode: implData[0].value as Hex,
      ...abiFrom(implData[1], implData[2]),
      via: proxy.kind,
    };
  }
  const ctx: CheckContext = { token, owner, code: codeTarget, codeMissing };

  const launch = discA.ponsV2
    ? { launchpad: PONS_V2, launcher: discA.ponsV2.launcher }
    : discA.ponsV1
      ? { launchpad: PONS_V1, launcher: discA.ponsV1.launcher }
      : null;
  const sourcifyDeployment = sourcifyTokenResult === null ? undefined : sourcifyTokenResult.deployment;
  const creator = viaFacts ? (facts?.creator ? { deployer: facts.creator.address, creationTxHash: facts.creator.creationTxHash } : null) : bsCreator;
  const deployer = launch?.launcher ?? sourcifyDeployment?.deployer ?? creator?.deployer ?? null;
  const unread = "the holder facts could not be read";

  const findings: Finding[] = [
    verifiedCheck(
      { address: token, sourcify: sourcifyTokenResult, blockscout: bs ? (bsContract ?? null) : undefined },
      proxy && proxy.kind !== "none" && implementation && implData
        ? { address: implementation, sourcify: implData[1], blockscout: bs ? (implData[2] ?? null) : undefined }
        : undefined,
    ),
    ownershipCheck(owner),
    proxyCheck(proxy, proxyFailure, codeTarget && codeTarget.via !== "token" ? detectFunctions(codeTarget, UPGRADE) : undefined),
    mintCheck(ctx),
    mutableFeeCheck(ctx),
    blacklistCheck(ctx),
    pausableCheck(ctx),
    venue.finding,
    sellSimulationFinding(exit, tokenInfo.decimals, block, skip),
    viaFacts
      ? holdersCheck({
          asked: true,
          totalSupply: tokenInfo.totalSupply ?? facts?.totalSupply ?? null,
          holderCount: facts?.holderCount ?? null,
          holders: facts?.holders ?? null,
          deployer,
          excluded: venue.excluded,
          source: facts?.source,
          missing: facts ? facts.holdersMissing : unread,
          block,
        })
      : holdersCheck({
          asked: bs !== null,
          totalSupply: tokenInfo.totalSupply ?? bsTokenInfo?.totalSupply ?? null,
          holderCount: bsTokenInfo?.holders ?? null,
          holders: bsHolders ?? null,
          deployer,
          excluded: venue.excluded,
        }),
    viaFacts
      ? originCheck({
          launch,
          sourcify: sourcifyDeployment,
          blockscout: creator ?? null,
          blockscoutSource: facts?.source,
          blockscoutMissing: facts ? facts.creatorMissing : unread,
        })
      : originCheck({ launch, sourcify: sourcifyDeployment, blockscout: bs ? (bsCreator ?? null) : undefined }),
  ];
  validateFindings(findings);

  const sourcifyMatch = sourcifyTokenResult === null ? "unknown" : sourcifyTokenResult.match;
  return {
    chainId,
    token: tokenInfo,
    block,
    findings,
    exit,
    code: {
      bytes: strip0x(code).length / 2,
      proxyImplementation: proxy && proxy.kind !== "none" ? implementation : null,
      owner: owner.state === "active" || owner.state === "renounced" ? owner.address : null,
      ownerRenounced: owner.state === "renounced",
      sourcify: sourcifyMatch,
    },
    timings: {
      totalMs: Date.now() - c.started,
      chainMs: chainDone - c.started,
      simulationMs,
      sourcesMs: sourcesDone - sourcesStarted,
      requests: { ...net.requests },
    },
    notice: CHECK_NOTICE,
  };
}
