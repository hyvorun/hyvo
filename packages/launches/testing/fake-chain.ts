/**
 * A stand-in Robinhood Chain for tests: the Pons V2 factory, curves, tokens and pair assets as plain
 * data, answering the JSON-RPC calls Hyvo Launches makes (eth_blockNumber, eth_getBlockByNumber,
 * eth_getLogs, and eth_call through Multicall3). Each endpoint can be given the limits public
 * endpoints have, such as a widest log span or a need for an address, so the reader's handling of
 * them can be tested. Used by this package's unit tests and by the web app's browser tests.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { ARBSYS, CURVE_ABI, ERC20_ABI, FACTORY_ABI, MULTICALL3, MULTICALL3_ABI, ARBSYS_ABI, NATIVE, PONS_V1_FACTORY, PONS_V2_FACTORY, TOPICS, V1_FACTORY_ABI } from "../src/pons";

export interface FakeAsset {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

export interface FakeLaunch {
  token: Address;
  curve: Address;
  creator: Address;
  feeRecipient?: Address;
  pairToken: Address;
  symbol: string;
  name: string;
  block: bigint;
  launchedAt: number;
  graduationThreshold: bigint;
  liquidity: bigint;
  creatorTaxBps?: number;
  feeBps?: number;
  buyback?: boolean;
  /** GraduationPhase index: 0 curve, 1 swept, 2 pool created, 3 rescued. */
  phase?: number;
  supply?: bigint;
  reserved?: bigint;
  sellable?: bigint;
  snipeTaxStartBps?: number;
  snipeTaxSeconds?: number;
  tickSpacing?: number;
}

export interface FakeTrade {
  curve: Address;
  side: "buy" | "sell";
  trader: Address;
  quote: bigint;
  tokens: bigint;
  fee?: bigint;
  tax?: bigint;
  block: bigint;
}

export interface FakeGraduation {
  token: Address;
  block: bigint;
  pairTokenAmount: bigint;
  tokenAmount: bigint;
}

export interface FakeV1Launch {
  token: Address;
  creator: Address;
  pairedToken: Address;
  symbol: string;
  name: string;
}

/** A contract that emits curve events and names the Pons factory, without being one of its curves. */
export interface FakeImpostor {
  curve: Address;
  claimsToken: Address;
}

export interface EndpointRules {
  /** Widest eth_getLogs span, in blocks; the refusal reads like Pocket's. */
  maxSpan?: number;
  spanMessage?: (limit: number, asked: number) => string;
  needsAddress?: boolean;
  maxAddresses?: number;
  /** Every request fails at the network. */
  down?: boolean;
  /** Every request is answered HTTP 429. */
  rateLimited?: boolean;
  /** Whether logs carry blockTimestamp. */
  timestamps?: boolean;
}

export interface FakeChainOptions {
  head: bigint;
  /** The head block's time, in seconds. */
  headTime: number;
  blocksPerSecond?: number;
  assets?: FakeAsset[];
  launches?: FakeLaunch[];
  trades?: FakeTrade[];
  graduations?: FakeGraduation[];
  v1?: FakeV1Launch[];
  impostors?: FakeImpostor[];
  /** Other tokens that exist but are not launches. */
  tokens?: { address: Address; symbol: string; name: string; decimals: number }[];
  endpoints?: Record<string, EndpointRules>;
}

interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown[];
}

const lower = (value: string) => value.toLowerCase();
const word = (address: Address) => `0x${lower(address).slice(2).padStart(64, "0")}` as Hex;

export class FakeChain {
  head: bigint;
  headTime: number;
  readonly pace: number;
  readonly assets: FakeAsset[];
  readonly launches: FakeLaunch[];
  readonly trades: FakeTrade[];
  readonly graduations: FakeGraduation[];
  readonly v1: FakeV1Launch[];
  readonly impostors: FakeImpostor[];
  readonly tokens: NonNullable<FakeChainOptions["tokens"]>;
  readonly endpoints: Record<string, EndpointRules>;
  /** Every request, for assertions: the endpoint, the method and its params. */
  readonly log: { url: string; method: string; params: unknown[] }[] = [];

  constructor(options: FakeChainOptions) {
    this.head = options.head;
    this.headTime = options.headTime;
    this.pace = options.blocksPerSecond ?? 9.6;
    this.assets = options.assets ?? [];
    this.launches = options.launches ?? [];
    this.trades = options.trades ?? [];
    this.graduations = options.graduations ?? [];
    this.v1 = options.v1 ?? [];
    this.impostors = options.impostors ?? [];
    this.tokens = options.tokens ?? [];
    this.endpoints = options.endpoints ?? {};
  }

  timeOf(block: bigint): number {
    return Math.round(this.headTime - Number(this.head - block) / this.pace);
  }

  /** A fetch that answers as the chain behind each endpoint would. */
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const rules = this.rulesFor(input);
    if (rules.down) throw new TypeError("fetch failed");
    if (rules.rateLimited) return new Response("Too Many Requests", { status: 429 });
    const body = JSON.parse(String(init.body ?? "{}")) as RpcRequest | RpcRequest[];
    const answer = Array.isArray(body) ? body.map((one) => this.answer(input, one, rules)) : this.answer(input, body, rules);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };

  /** The JSON-RPC answer to one request at `url`. */
  answerText(url: string, text: string): string {
    const rules = this.rulesFor(url);
    const body = JSON.parse(text) as RpcRequest | RpcRequest[];
    return JSON.stringify(Array.isArray(body) ? body.map((one) => this.answer(url, one, rules)) : this.answer(url, body, rules));
  }

  private rulesFor(url: string): EndpointRules {
    const key = Object.keys(this.endpoints).find((prefix) => url.startsWith(prefix));
    return key ? this.endpoints[key]! : {};
  }

  private answer(url: string, request: RpcRequest, rules: EndpointRules) {
    const params = request.params ?? [];
    this.log.push({ url, method: request.method, params });
    try {
      return { jsonrpc: "2.0", id: request.id, result: this.result(request.method, params, rules) };
    } catch (error) {
      const failure = error as { code?: number; message?: string };
      return { jsonrpc: "2.0", id: request.id, error: { code: failure.code ?? -32000, message: failure.message ?? String(error) } };
    }
  }

  private result(method: string, params: unknown[], rules: EndpointRules): unknown {
    switch (method) {
      case "eth_chainId":
        return "0x1237";
      case "eth_blockNumber":
        return toHex(this.head);
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        const number = tag === "latest" ? this.head : BigInt(tag);
        if (number > this.head || number < 0n) return null;
        return { number: toHex(number), timestamp: toHex(this.timeOf(number)), hash: keccak256(toHex(number)) };
      }
      case "eth_getLogs":
        return this.logs(params[0] as Record<string, unknown>, rules);
      case "eth_call":
        return this.call(params[0] as { to: Address; data: Hex });
      default:
        throw Object.assign(new Error(`the fake chain does not answer ${method}`), { code: -32601 });
    }
  }

  private logs(filter: Record<string, unknown>, rules: EndpointRules) {
    const from = BigInt(filter.fromBlock as string);
    const to = filter.toBlock === "latest" ? this.head : BigInt(filter.toBlock as string);
    const asked = Number(to - from + 1n);
    const addresses = filter.address === undefined ? null : (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => lower(String(a)));
    if (rules.needsAddress && !addresses) throw Object.assign(new Error("invalid argument 0: missing required field 'address' for log filter"), { code: -32602 });
    if (rules.maxAddresses && addresses && addresses.length > rules.maxAddresses) {
      throw Object.assign(new Error(`invalid argument 0: 'address' filter exceeds the maximum of ${rules.maxAddresses} addresses per request`), { code: -32602 });
    }
    if (rules.maxSpan && asked > rules.maxSpan) {
      const message = rules.spanMessage?.(rules.maxSpan, asked) ?? `invalid argument 0: block range exceeds maximum ${rules.maxSpan}`;
      throw Object.assign(new Error(message), { code: -32602 });
    }
    const topics = (filter.topics as (string | string[] | null)[] | undefined) ?? [];
    const matches = (position: number, value: Hex) => {
      const wanted = topics[position];
      if (wanted === undefined || wanted === null) return true;
      return Array.isArray(wanted) ? wanted.map(lower).includes(lower(value)) : lower(wanted) === lower(value);
    };
    const out = this.allLogs().filter(
      (log) =>
        log.block >= from &&
        log.block <= to &&
        (!addresses || addresses.includes(lower(log.address))) &&
        log.topics.every((topic, i) => matches(i, topic)) &&
        topics.length <= log.topics.length,
    );
    return out.map((log) => ({
      address: lower(log.address),
      topics: log.topics,
      data: log.data,
      blockNumber: toHex(log.block),
      transactionHash: log.txHash,
      logIndex: toHex(log.logIndex),
      ...(rules.timestamps === false ? {} : { blockTimestamp: toHex(this.timeOf(log.block)) }),
      removed: false,
    }));
  }

  private allLogs(): { address: Address; topics: Hex[]; data: Hex; block: bigint; txHash: Hex; logIndex: number }[] {
    const out: { address: Address; topics: Hex[]; data: Hex; block: bigint; txHash: Hex; logIndex: number }[] = [];
    this.launches.forEach((launch, i) => {
      out.push({
        address: PONS_V2_FACTORY,
        topics: encodeEventTopics({ abi: FACTORY_ABI, eventName: "TokenLaunched", args: { token: launch.token, curve: launch.curve, deployer: launch.creator } }) as Hex[],
        data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [launch.pairToken, 0n, launch.graduationThreshold]),
        block: launch.block,
        txHash: keccak256(toHex(`launch-${i}`)),
        logIndex: 2,
      });
    });
    this.graduations.forEach((graduation, i) => {
      out.push({
        address: PONS_V2_FACTORY,
        topics: encodeEventTopics({ abi: FACTORY_ABI, eventName: "PoolGraduated", args: { token: graduation.token } }) as Hex[],
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [BigInt(1000 + i), graduation.tokenAmount, graduation.pairTokenAmount]),
        block: graduation.block,
        txHash: keccak256(toHex(`graduation-${i}`)),
        logIndex: 5,
      });
    });
    this.trades.forEach((trade, i) => {
      const topics = encodeEventTopics({
        abi: CURVE_ABI,
        eventName: trade.side === "buy" ? "CurveBuy" : "CurveSell",
        args: trade.side === "buy" ? { buyer: trade.trader, recipient: trade.trader } : { seller: trade.trader, recipient: trade.trader },
      }) as Hex[];
      const fee = trade.fee ?? trade.quote / 100n;
      const tax = trade.tax ?? 0n;
      const data =
        trade.side === "buy"
          ? encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [trade.quote, trade.tokens, fee, tax])
          : encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [trade.tokens, trade.quote - fee - tax, fee, tax]);
      out.push({ address: trade.curve, topics, data, block: trade.block, txHash: keccak256(toHex(`trade-${i}`)), logIndex: 1 });
    });
    return out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  }

  private call({ to, data }: { to: Address; data: Hex }): Hex {
    if (lower(to) !== lower(MULTICALL3)) throw Object.assign(new Error("execution reverted"), { code: 3 });
    const { functionName, args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    if (functionName !== "aggregate3") throw Object.assign(new Error("execution reverted"), { code: 3 });
    const calls = (args as unknown as [readonly { target: Address; allowFailure: boolean; callData: Hex }[]])[0];
    const results = calls.map((call) => {
      const returnData = this.subcall(call.target, call.callData);
      return returnData === null ? { success: false, returnData: "0x" as Hex } : { success: true, returnData };
    });
    return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: results });
  }

  private subcall(target: Address, data: Hex): Hex | null {
    const t = lower(target);
    try {
      if (t === lower(ARBSYS)) return encodeFunctionResult({ abi: ARBSYS_ABI, functionName: "arbBlockNumber", result: this.head });
      if (t === lower(MULTICALL3)) return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp", result: BigInt(this.headTime) });
      if (t === lower(PONS_V2_FACTORY)) {
        const { args } = decodeFunctionData({ abi: FACTORY_ABI, data });
        const token = lower(String((args as readonly unknown[] | undefined)?.[0]));
        const launch = this.launches.find((item) => lower(item.token) === token);
        return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "getLaunchedToken", result: launch ? record(launch) : emptyRecord() });
      }
      if (t === lower(PONS_V1_FACTORY)) {
        const { args } = decodeFunctionData({ abi: V1_FACTORY_ABI, data });
        const token = lower(String((args as readonly unknown[] | undefined)?.[0]));
        const launch = this.v1.find((item) => lower(item.token) === token);
        return encodeFunctionResult({ abi: V1_FACTORY_ABI, functionName: "getLaunchedToken", result: v1Record(launch) });
      }
      const asset = this.assets.find((item) => lower(item.address) === t) ?? this.tokens.find((item) => lower(item.address) === t);
      if (asset) return erc20(data, asset);
      const token = this.launches.find((item) => lower(item.token) === t) ?? this.v1.find((item) => lower(item.token) === t);
      if (token) return erc20(data, { symbol: token.symbol, name: token.name, decimals: 18 });
      const curve = this.launches.find((item) => lower(item.curve) === t);
      if (curve) return curveAnswer(data, curve);
      const impostor = this.impostors.find((item) => lower(item.curve) === t);
      if (impostor) {
        const { functionName } = decodeFunctionData({ abi: CURVE_ABI, data });
        if (functionName === "factory") return encodeFunctionResult({ abi: CURVE_ABI, functionName: "factory", result: PONS_V2_FACTORY });
        if (functionName === "token") return encodeFunctionResult({ abi: CURVE_ABI, functionName: "token", result: impostor.claimsToken });
      }
      return null;
    } catch {
      return null;
    }
  }
}

function erc20(data: Hex, token: { symbol: string; name: string; decimals: number }): Hex {
  const { functionName } = decodeFunctionData({ abi: ERC20_ABI, data });
  if (functionName === "symbol") return encodeFunctionResult({ abi: ERC20_ABI, functionName, result: token.symbol });
  if (functionName === "name") return encodeFunctionResult({ abi: ERC20_ABI, functionName, result: token.name });
  return encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: token.decimals });
}

function curveAnswer(data: Hex, launch: FakeLaunch): Hex {
  const { functionName } = decodeFunctionData({ abi: CURVE_ABI, data });
  const graduated = (launch.phase ?? 0) > 0;
  const values: Record<string, unknown> = {
    token: launch.token,
    factory: PONS_V2_FACTORY,
    pairToken: launch.pairToken,
    feeBps: BigInt(launch.feeBps ?? 100),
    creatorTaxBps: BigInt(launch.creatorTaxBps ?? 0),
    graduationThreshold: launch.graduationThreshold,
    realQuoteReserve: graduated ? 0n : launch.liquidity,
    graduated,
    launchedAt: BigInt(launch.launchedAt),
    launchSupply: launch.supply ?? 10n ** 27n,
    reservedTokens: launch.reserved ?? 285_714_285_714_285_714_285_714_285n,
    sellableTokens: launch.sellable ?? 600_000_000n * 10n ** 18n,
    buybackEnabled: launch.buyback ?? false,
    snipeTaxStartBps: BigInt(launch.snipeTaxStartBps ?? 9900),
    snipeTaxSeconds: BigInt(launch.snipeTaxSeconds ?? 3),
  };
  if (!(functionName in values)) throw new Error("no such function");
  return encodeFunctionResult({ abi: CURVE_ABI, functionName, result: values[functionName] } as Parameters<typeof encodeFunctionResult>[0]);
}

function record(launch: FakeLaunch) {
  return {
    token: getAddress(launch.token),
    curve: getAddress(launch.curve),
    deployer: getAddress(launch.creator),
    creatorFeeRecipient: getAddress(launch.feeRecipient ?? launch.creator),
    pairToken: getAddress(launch.pairToken),
    graduationThreshold: launch.graduationThreshold,
    poolFee: 0,
    tickSpacing: launch.tickSpacing ?? 200,
    creatorTaxBps: launch.creatorTaxBps ?? 0,
    buybackEnabled: launch.buyback ?? false,
    phase: launch.phase ?? 0,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: true,
  };
}

function emptyRecord() {
  return {
    token: NATIVE,
    curve: NATIVE,
    deployer: NATIVE,
    creatorFeeRecipient: NATIVE,
    pairToken: NATIVE,
    graduationThreshold: 0n,
    poolFee: 0,
    tickSpacing: 0,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: 0,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: false,
  };
}

function v1Record(launch: FakeV1Launch | undefined) {
  return {
    token: launch ? getAddress(launch.token) : NATIVE,
    deployer: launch ? getAddress(launch.creator) : NATIVE,
    pairedToken: launch ? getAddress(launch.pairedToken) : NATIVE,
    positionManager: NATIVE,
    positionId: 0n,
    dexId: 0n,
    launchConfigId: 0n,
    restrictionsEndBlock: 0n,
    supply: launch ? 10n ** 27n : 0n,
    isToken0: false,
    poolFee: launch ? 10_000 : 0,
    exists: Boolean(launch),
    initialBuyAmount: 0n,
  };
}

/** A deterministic address from a label, for building fixtures. */
export function fakeAddress(label: string): Address {
  return getAddress(`0x${keccak256(toHex(label)).slice(-40)}`);
}

export { word as addressTopic, TOPICS };
