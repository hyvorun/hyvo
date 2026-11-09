/**
 * Typed configuration from the Worker's vars (wrangler.jsonc) and secrets. A feature whose
 * addresses or RPC are missing is off rather than half-working: payments need RPC_URLS,
 * PAYMENT_ROUTER_ADDRESS and USDG_ADDRESS; oracle commits need RPC_URLS, ORACLE_ADDRESS and
 * ATTESTER_PRIVATE_KEY; holder benefits need RPC_URLS, HYVO_TOKEN_ADDRESS and a HOLDER_MIN above 0, since with a
 * minimum of 0 no wallet could ever qualify (lib/holder.ts).
 */
import { formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import type { Env } from "../env";

export interface Token {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface Config {
  chainId: number;
  rpcUrls: string[];
  blockTimeMs: number;
  oracle: Address | null;
  router: Address | null;
  routerDeployBlock: bigint;
  confirmations: bigint;
  logRange: bigint;
  logRangesPerRun: number;
  usdg: Token | null;
  hyvoToken: Token | null;
  treasury: Address | null;
  attesterKey: Hex | null;
  verifyRuns: boolean;
  /** The domains a sign-in may name, the canonical one first. Several only while the site moves to a new domain. */
  siweDomains: string[];
  /** The web app's origins, the canonical one first: CORS, sign-in and the browser MCP check accept each. */
  webOrigins: string[];
  /** The canonical web origin, for links. */
  webOrigin: string;
  admins: ReadonlySet<string>;
  pricing: {
    multiplier: number;
    floorUsd: number;
    stepUsd: number;
    costPerAgentRoundUsd: number;
    reportCostUsd: number;
    budgetHeadroom: number;
    quoteTtlS: number;
  };
  balance: { topUpMinUsd: number; topUpMaxUsd: number };
  ask: { priceUsd: number; model: string };
  questions: { minDelayS: number; maxDelayS: number };
  sizes: { minAgents: number; maxAgents: number; minRounds: number; maxRounds: number; maxRunDecisions: number; batchSize: number };
  holder: {
    /** HOLDER_MIN in the token's base units; 0 when it is unset or not a decimal number. */
    min: bigint;
    /** The same in whole tokens, as a plain decimal string: "1000", "2.5". */
    minText: string;
    discountBps: number;
    freeRunsPerMonth: number;
    freeRunMaxAgents: number;
    freeRunMaxRounds: number;
  };
  queue: { dailyCapUsd: number; jobTimeoutS: number; heartbeatIntervalS: number; heartbeatTimeoutS: number };
  features: { payments: boolean; oracle: boolean; holder: boolean; clone: boolean };
}

const cache = new WeakMap<Env, Config>();

export function config(env: Env): Config {
  let value = cache.get(env);
  if (!value) {
    value = load(env);
    cache.set(env, value);
  }
  return value;
}

function load(env: Env): Config {
  const rpcUrls = list(env.RPC_URLS).filter((url) => /^https?:\/\//.test(url));
  const usdgAddress = address(env.USDG_ADDRESS);
  const hyvoAddress = address(env.HYVO_TOKEN_ADDRESS);
  const hyvoDecimals = int(env.HYVO_TOKEN_DECIMALS, 18);
  const key = (env.ATTESTER_PRIVATE_KEY ?? "").trim();
  const attesterKey = /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as Hex) : null;
  const holderMinText = (env.HOLDER_MIN ?? "").trim();
  const holderMin = /^[0-9]+(\.[0-9]+)?$/.test(holderMinText) ? parseUnits(holderMinText, hyvoDecimals) : 0n;
  const oracle = address(env.ORACLE_ADDRESS);
  const router = address(env.PAYMENT_ROUTER_ADDRESS);
  const hasRpc = rpcUrls.length > 0;
  return {
    chainId: int(env.CHAIN_ID, 4663),
    rpcUrls,
    blockTimeMs: num(env.CHAIN_BLOCK_TIME_MS, 100),
    oracle,
    router,
    routerDeployBlock: BigInt(int(env.PAYMENT_ROUTER_DEPLOY_BLOCK, 0)),
    confirmations: BigInt(int(env.PAYMENT_CONFIRMATIONS, 20)),
    logRange: BigInt(Math.max(1, int(env.LOG_RANGE_BLOCKS, 100))),
    logRangesPerRun: Math.max(1, int(env.LOG_RANGES_PER_RUN, 20)),
    usdg: usdgAddress ? { address: usdgAddress, symbol: "USDG", decimals: int(env.USDG_DECIMALS, 6) } : null,
    hyvoToken: hyvoAddress ? { address: hyvoAddress, symbol: "HYVO", decimals: hyvoDecimals } : null,
    treasury: address(env.TREASURY_ADDRESS),
    attesterKey,
    verifyRuns: (env.VERIFY_RUNS_IN_WORKER ?? "").trim() === "1",
    siweDomains: list(env.SIWE_DOMAIN),
    webOrigins: webOrigins(env),
    webOrigin: webOrigins(env)[0] ?? "",
    admins: new Set(list(env.ADMIN_ADDRESSES).filter((a) => isAddress(a)).map((a) => a.toLowerCase())),
    pricing: {
      multiplier: num(env.PRICE_MULTIPLIER, 2.5),
      floorUsd: num(env.PRICE_FLOOR_USD, 1),
      stepUsd: Math.max(0.01, num(env.PRICE_STEP_USD, 1)),
      costPerAgentRoundUsd: num(env.COST_PER_AGENT_ROUND_USD, 0.0003),
      reportCostUsd: num(env.REPORT_COST_USD, 0.02),
      budgetHeadroom: num(env.BUDGET_HEADROOM, 2),
      quoteTtlS: int(env.QUOTE_TTL_S, 1800),
    },
    balance: { topUpMinUsd: num(env.TOPUP_MIN_USD, 1), topUpMaxUsd: num(env.TOPUP_MAX_USD, 500) },
    ask: { priceUsd: num(env.ASK_PRICE_USD, 0.01), model: (env.ASK_MODEL ?? "").trim() || "@cf/meta/llama-3.1-8b-instruct-fp8-fast" },
    questions: { minDelayS: int(env.QUESTION_MIN_DELAY_S, 3600), maxDelayS: int(env.QUESTION_MAX_DELAY_S, 365 * 86_400) },
    sizes: {
      minAgents: int(env.MIN_AGENTS, 10),
      maxAgents: int(env.MAX_AGENTS, 2000),
      minRounds: int(env.MIN_ROUNDS, 3),
      maxRounds: int(env.MAX_ROUNDS, 30),
      maxRunDecisions: int(env.MAX_RUN_DECISIONS, 15_000),
      batchSize: int(env.BATCH_SIZE, 10),
    },
    holder: {
      min: holderMin,
      minText: formatUnits(holderMin, hyvoDecimals),
      discountBps: Math.min(10_000, int(env.HOLDER_DISCOUNT_BPS, 0)),
      freeRunsPerMonth: int(env.FREE_RUNS_PER_MONTH, 0),
      freeRunMaxAgents: int(env.FREE_RUN_MAX_AGENTS, 50),
      freeRunMaxRounds: int(env.FREE_RUN_MAX_ROUNDS, 10),
    },
    queue: {
      dailyCapUsd: num(env.DAILY_SPEND_CAP_USD, 0),
      jobTimeoutS: int(env.JOB_TIMEOUT_S, 1800),
      heartbeatIntervalS: int(env.HEARTBEAT_INTERVAL_S, 15),
      heartbeatTimeoutS: int(env.HEARTBEAT_TIMEOUT_S, 90),
    },
    features: {
      payments: hasRpc && router !== null && usdgAddress !== null,
      oracle: hasRpc && oracle !== null && attesterKey !== null,
      holder: hasRpc && hyvoAddress !== null && holderMin > 0n,
      clone: env.CLONES_ENABLED === "1",
    },
  };
}

/** WEB_ORIGIN, which may list several origins (comma-separated) while the site moves to a new domain. */
export function webOrigins(env: Pick<Env, "WEB_ORIGIN">): string[] {
  return list(env.WEB_ORIGIN);
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function address(value: string | undefined): Address | null {
  const text = (value ?? "").trim();
  return isAddress(text, { strict: false }) && !/^0x0{40}$/i.test(text) ? getAddress(text) : null;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number((value ?? "").trim());
  return (value ?? "").trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = num(value, fallback);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
