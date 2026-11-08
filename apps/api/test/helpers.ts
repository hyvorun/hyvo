/** Shared helpers for the Phase 3 API tests: requests, SIWE sessions, an in-memory chain. */
import { env } from "cloudflare:test";
import { hashRun, scenarioHash, summarizeRun, type RunMeta } from "@hyvo/schema";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import goldenText from "../../../fixtures/golden-run.json?raw";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { backgroundDone } from "../src/lib/background";
import type { ChainGateway, CommitOnChain, PaidLog, TxStatus } from "../src/lib/chain";
import { setChainFactory } from "../src/lib/chain";
import { setClock } from "../src/lib/clock";
import { sha256Bytes } from "../src/lib/ids";

export const RUNNER_TOKEN = "test-runner-token";
export const golden = JSON.parse(goldenText);

// Well-known anvil test keys; never used outside tests.
export const KEYS = {
  user: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  other: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  admin: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  attester: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
} as const;

export const ADDRESSES = {
  router: "0x00000000000000000000000000000000000000a1",
  oracle: "0x00000000000000000000000000000000000000a2",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  hyvo: "0x00000000000000000000000000000000000000a3",
  other: "0x00000000000000000000000000000000000000a4",
} as const;

export function account(key: Hex) {
  return privateKeyToAccount(key);
}

/** The test env with every feature on (payments, oracle, holder). */
export function chainEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    RPC_URLS: "http://chain.test",
    PAYMENT_ROUTER_ADDRESS: ADDRESSES.router,
    ORACLE_ADDRESS: ADDRESSES.oracle,
    HYVO_TOKEN_ADDRESS: ADDRESSES.hyvo,
    HOLDER_MIN: "1000",
    FREE_RUNS_PER_MONTH: "2",
    ATTESTER_PRIVATE_KEY: KEYS.attester,
    ADMIN_ADDRESSES: account(KEYS.admin).address,
    PAYMENT_CONFIRMATIONS: "2",
    LOG_RANGE_BLOCKS: "10",
    LOG_RANGES_PER_RUN: "5",
    ...overrides,
  } as Env;
}

/** A request, answered once any work it started in the background is done. */
export async function call(target: Env, path: string, init?: RequestInit): Promise<Response> {
  const response = await app.request(`https://api.test${path}`, init, target);
  await backgroundDone();
  return response;
}

export function json(target: Env, path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return call(target, path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function runner(target: Env, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return call(target, path, {
    method,
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Sign in with SIWE; returns the bearer header. */
export async function signIn(target: Env, key: Hex, now = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  const who = account(key);
  const { nonce } = (await (await json(target, "/v1/auth/siwe/nonce", {})).json()) as { nonce: string };
  const message = siweMessage(who.address, nonce, now);
  const signature = await who.signMessage({ message });
  const response = await json(target, "/v1/auth/siwe/verify", { message, signature });
  if (response.status !== 201) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  const { token } = (await response.json()) as { token: string };
  return { Authorization: `Bearer ${token}` };
}

export function siweMessage(
  address: Address,
  nonce: string,
  now: number,
  overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {},
): string {
  return createSiweMessage({
    address,
    chainId: 4663,
    domain: "localhost:5173",
    nonce,
    uri: "http://localhost:5173",
    version: "1",
    issuedAt: new Date(now * 1000),
    statement: "Sign in to Hyvo. This is a signature, not a transaction.",
    ...overrides,
  });
}

/** The golden run's scenario, so a delivered copy of the golden run is the job that was ordered. */
export const scenario = {
  title: golden.scenario.title as string,
  seedText: "GLINT is a fictional token made up for this test.",
  events: golden.scenario.injectedEvents as { round: number; text: string }[],
  market: { tokenSymbol: golden.world.token.symbol as string, liquidityEth: "5", feeBps: 500 },
};

/** A valid run.json with the golden content under another runId (re-hashed). */
export function runFor(runId: string, edit: (run: Record<string, any>) => void = () => {}): string {
  const run = structuredClone(golden);
  run.runId = runId;
  edit(run);
  delete run.hash;
  run.hash = hashRun(run);
  return JSON.stringify(run);
}

/** What a runner reports about a run.json it verified. */
export async function metaFor(body: string): Promise<RunMeta> {
  const run = JSON.parse(body);
  return {
    hash: run.hash,
    scenarioHash: scenarioHash(run.scenario),
    sha256: await sha256Bytes(new TextEncoder().encode(body)),
    summary: summarizeRun(run),
    usage: { costUsd: run.usage.costUsd, llmCalls: run.usage.llmCalls },
    eventRounds: run.scenario.injectedEvents.map((event: { round: number }) => event.round),
  };
}

/** Freeze time at `start`; returns a function that moves it. */
export function frozenClock(start: number): { now: () => number; advance: (seconds: number) => void } {
  let current = start;
  setClock(() => current);
  return { now: () => current, advance: (seconds: number) => void (current += seconds) };
}

export type FlakyDb = D1Database & {
  /** The next `batch` throws, as D1 does when a connection is lost, and changes nothing. */
  failNextBatch(): void;
  /** Runs `hook` right before the next `batch`, to change the world between a check and a write. */
  beforeNextBatch(hook: () => Promise<void>): void;
  /** The next statement matching `pattern` throws when it runs. */
  failNextPrepare(pattern: RegExp): void;
};

export function flakyDb(db: D1Database): FlakyDb {
  let failBatch = false;
  let hook: (() => Promise<void>) | null = null;
  let failing: RegExp | null = null;
  const lost = () => new Error("D1_ERROR: Network connection lost.");
  return new Proxy(db, {
    get(target, property) {
      if (property === "failNextBatch") return () => void (failBatch = true);
      if (property === "beforeNextBatch") return (next: () => Promise<void>) => void (hook = next);
      if (property === "failNextPrepare") return (pattern: RegExp) => void (failing = pattern);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (failBatch) {
            failBatch = false;
            throw lost();
          }
          if (hook) {
            const run = hook;
            hook = null;
            await run();
          }
          return target.batch(statements);
        };
      }
      if (property === "prepare") {
        return (sql: string) => {
          if (failing?.test(sql)) {
            failing = null;
            const refuse = async () => {
              throw lost();
            };
            const statement = { bind: () => statement, run: refuse, first: refuse, all: refuse };
            return statement;
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FlakyDb;
}

export async function resetDb(): Promise<void> {
  const tables = [
    "runs",
    "siwe_nonces",
    "sessions",
    "orders",
    "payments",
    "jobs",
    "spend",
    "refunds",
    "oracle_commits",
    "credit_usage",
    "kv",
    "rate_limits",
    "clones",
    "api_keys",
    "balances",
    "balance_entries",
    "topups",
    "webhooks",
    "webhook_deliveries",
    "questions",
  ];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

// --- an in-memory chain --------------------------------------------------------------------------

interface Receipt extends TxStatus {
  paid: PaidLog[];
}

export class FakeChain implements ChainGateway {
  block = 10_000_000n;
  blockTime = 0n; // set from the frozen clock
  logs: PaidLog[] = [];
  receipts = new Map<string, Receipt>();
  balances = new Map<string, { now: bigint; past: bigint }>();
  commits = new Map<string, CommitOnChain>();
  sent: { runIdBytes32: Hex; reportHash: Hex; scenarioHash: Hex; resolvesAt: bigint }[] = [];
  resolved: { runIdBytes32: Hex; outcomeHash: Hex; outcomeUri: string }[] = [];
  txs = new Map<string, TxStatus>();
  failSend = false;
  failReads = false;
  private counter = 0;

  constructor(private readonly clock: () => number) {}

  install(): this {
    setChainFactory(() => this);
    return this;
  }

  /** Mine a block holding `Paid(orderId, payer, token, amount)`; returns the transaction hash. */
  pay(orderId: string, payer: Address, token: string, amount: bigint, opts: { reverted?: boolean; at?: number } = {}): Hex {
    this.block += 1n;
    const txHash = keccak256(toHex(`tx-${++this.counter}`));
    const log: PaidLog = {
      orderId: orderId as Hex,
      payer,
      token: getAddress(token),
      amount,
      timestamp: BigInt(opts.at ?? this.clock()),
      blockNumber: this.block,
      txHash,
      logIndex: 0,
    };
    if (!opts.reverted) this.logs.push(log);
    this.receipts.set(txHash, {
      status: opts.reverted ? "reverted" : "success",
      blockNumber: this.block,
      paid: opts.reverted ? [] : [log],
    });
    return txHash;
  }

  mine(blocks: number): void {
    this.block += BigInt(blocks);
  }

  async latestBlock() {
    return this.block;
  }

  async blockTimestamp(blockNumber: bigint) {
    // 0.1 s blocks ending at "now".
    return BigInt(this.clock()) - (this.block - blockNumber) / 10n;
  }

  async paidLogs(router: Address, fromBlock: bigint, toBlock: bigint) {
    if (router.toLowerCase() !== ADDRESSES.router) return [];
    return this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
  }

  async paymentReceipt(_router: Address, txHash: Hex) {
    if (this.failReads) throw new Error("the RPC is down");
    return this.receipts.get(txHash) ?? null;
  }

  async balanceOf(_token: Address, owner: Address, blockNumber?: bigint) {
    const entry = this.balances.get(owner.toLowerCase());
    if (!entry) return 0n;
    return blockNumber === undefined ? entry.now : entry.past;
  }

  async getCommit(_oracle: Address, runIdBytes32: Hex) {
    return this.commits.get(runIdBytes32) ?? null;
  }

  async sendCommit(_oracle: Address, args: { runIdBytes32: Hex; reportHash: Hex; scenarioHash: Hex; resolvesAt: bigint }) {
    if (this.failSend) throw new Error("insufficient funds for gas");
    this.sent.push(args);
    this.block += 1n;
    const txHash = keccak256(toHex(`commit-${++this.counter}`));
    this.commits.set(args.runIdBytes32, {
      reportHash: args.reportHash,
      scenarioHash: args.scenarioHash,
      resolvesAt: args.resolvesAt,
      committedAt: BigInt(this.clock()),
      resolvedAt: 0n,
      outcomeHash: `0x${"0".repeat(64)}`,
    });
    this.txs.set(txHash, { status: "success", blockNumber: this.block });
    return txHash;
  }

  async sendResolve(_oracle: Address, args: { runIdBytes32: Hex; outcomeHash: Hex; outcomeUri: string }) {
    if (this.failSend) throw new Error("insufficient funds for gas");
    this.resolved.push(args);
    this.block += 1n;
    const txHash = keccak256(toHex(`resolve-${++this.counter}`));
    const commit = this.commits.get(args.runIdBytes32);
    if (commit) this.commits.set(args.runIdBytes32, { ...commit, resolvedAt: BigInt(this.clock()), outcomeHash: args.outcomeHash });
    this.txs.set(txHash, { status: "success", blockNumber: this.block });
    return txHash;
  }

  async txStatus(txHash: Hex) {
    return this.txs.get(txHash) ?? null;
  }

  async verifyMessage() {
    return false;
  }
}
