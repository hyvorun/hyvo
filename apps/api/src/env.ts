/** Worker bindings (wrangler.jsonc) and secrets (.dev.vars locally, Wrangler secrets deployed). */
export interface Env {
  DB: D1Database;
  /** run.json files. Workers KV: free without a payment method (docs/OPEN_ITEMS.md item 21). */
  ARTIFACTS: KVNamespace;
  /** Workers AI for the runner's LLM calls; no key, free daily allocation. */
  AI?: Ai;
  API_VERSION: string;
  WEB_ORIGIN: string;
  PUBLIC_API_URL: string;

  // Secrets
  RUNNER_TOKEN: string;
  ARTIFACT_SIGNING_KEY: string;
  /** The engine's key for routes/llm.ts, and nothing else. Empty = the route is closed. */
  LLM_TOKEN?: string;
  /** Signs HyvoOracle.commit; lives only in the Worker. Empty = no oracle commits. */
  ATTESTER_PRIVATE_KEY?: string;
  /**
   * Blockscout's API key (docs/OPEN_ITEMS.md item 24), for Hyvo Check's top holders (lib/holders.ts). It goes to
   * Blockscout and nowhere else: no answer, header, error or log carries it. Empty = holders are skipped.
   */
  BLOCKSCOUT_API_KEY?: string;

  /** "1" parses and re-hashes each run in the Worker: needs Workers Paid (docs/OPEN_ITEMS.md item 21). */
  VERIFY_RUNS_IN_WORKER: string;

  // Chain (empty addresses or RPC_URLS turn the matching feature off; docs/RUNBOOK.md)
  CHAIN_ID: string;
  RPC_URLS: string;
  CHAIN_BLOCK_TIME_MS: string;
  ORACLE_ADDRESS: string;
  PAYMENT_ROUTER_ADDRESS: string;
  PAYMENT_ROUTER_DEPLOY_BLOCK: string;
  PAYMENT_CONFIRMATIONS: string;
  LOG_RANGE_BLOCKS: string;
  LOG_RANGES_PER_RUN: string;
  USDG_ADDRESS: string;
  USDG_DECIMALS: string;
  HYVO_TOKEN_ADDRESS: string;
  HYVO_TOKEN_DECIMALS: string;
  TREASURY_ADDRESS: string;

  // Sign-in and admin
  SIWE_DOMAIN: string;
  ADMIN_ADDRESSES: string;

  // Pricing (SPEC 8.3): price = max(floor, ceil_step(estimatedLlmCost x multiplier x (1 - discount)))
  PRICE_MULTIPLIER: string;
  PRICE_FLOOR_USD: string;
  PRICE_STEP_USD: string;
  COST_PER_AGENT_ROUND_USD: string;
  REPORT_COST_USD: string;
  BUDGET_HEADROOM: string;
  QUOTE_TTL_S: string;

  // Prepaid balances: the top-up range, and the price of one question to an agent
  TOPUP_MIN_USD: string;
  TOPUP_MAX_USD: string;
  ASK_PRICE_USD: string;
  ASK_MODEL: string;

  // Scenario questions: how far away a question's date can be
  QUESTION_MIN_DELAY_S: string;
  QUESTION_MAX_DELAY_S: string;

  // Run sizes
  CLONES_ENABLED: string;
  MIN_AGENTS: string;
  MAX_AGENTS: string;
  MAX_RUN_DECISIONS: string;
  MIN_ROUNDS: string;
  MAX_ROUNDS: string;
  BATCH_SIZE: string;

  // Holder benefits (off while HYVO_TOKEN_ADDRESS is empty)
  HOLDER_MIN: string;
  HOLDER_DISCOUNT_BPS: string;
  FREE_RUNS_PER_MONTH: string;
  FREE_RUN_MAX_AGENTS: string;
  FREE_RUN_MAX_ROUNDS: string;

  // Queue
  DAILY_SPEND_CAP_USD: string;
  JOB_TIMEOUT_S: string;
  HEARTBEAT_INTERVAL_S: string;
  HEARTBEAT_TIMEOUT_S: string;
}

export type AppEnv = { Bindings: Env; Variables: { address: string } };
