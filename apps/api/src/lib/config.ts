/**
 * Typed configuration from the Worker's vars (wrangler.jsonc) and secrets. A feature whose
 * addresses or RPC are missing is off rather than half-working: payments need RPC_URLS,
 * PAYMENT_ROUTER_ADDRESS and USDG_ADDRESS; oracle commits need RPC_URLS, ORACLE_ADDRESS and
 * ATTESTER_PRIVATE_KEY; holder benefits need RPC_URLS and HYVO_TOKEN_ADDRESS.
 */
import { getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
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
  siweDomain: string;
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
    min: bigint;
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
  const holderMin = (env.HOLDER_MIN ?? "").trim() || "0";
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
    siweDomain: (env.SIWE_DOMAIN ?? "").trim(),
    webOrigin: env.WEB_ORIGIN,
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
      min: /^[0-9]+(\.[0-9]+)?$/.test(holderMin) ? parseUnits(holderMin, hyvoDecimals) : 0n,
      minText: holderMin,
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
      holder: hasRpc && hyvoAddress !== null,
      clone: env.CLONES_ENABLED === "1",
    },
  };
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
