import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DISCLAIMER, RunV1, runIdToBytes32, scenarioHash, summarizeRun, type Order } from "@hyvo/schema";
import type { Page, Route } from "@playwright/test";

export const goldenText = readFileSync(
  fileURLToPath(new URL("../../../fixtures/golden-run.json", import.meta.url)),
  "utf8",
);
export const golden = RunV1.parse(JSON.parse(goldenText));
export const summary = { ...summarizeRun(golden), publishedAt: "2026-11-03T12:00:00Z", featured: true };

export const ADDRESSES = {
  oracle: "0x00000000000000000000000000000000000dd003",
  router: "0x00000000000000000000000000000000000dd002",
  usdg: "0x00000000000000000000000000000000000dd001",
} as const;
export const COMMIT_TX = `0x${"c0".repeat(32)}`;
/** A paid run that is still running (no run.json yet). */
export const RUNNING_ID = "run_01M6GCKE58E5YXTK38CQ5RRWEB";
export const NEW_RUN_ID = "run_01M6GCNGJ86TP776QYQD4Z7MFF";
export const ORDER_ID = `0x${"0a".repeat(32)}`;

const API = "http://api.test";

export const goldenEntry = {
  runId: golden.runId,
  runIdBytes32: runIdToBytes32(golden.runId),
  reportHash: golden.hash,
  scenarioHash: scenarioHash(golden.scenario),
  title: golden.scenario.title,
  status: "confirmed",
  txHash: COMMIT_TX,
  blockNumber: 16,
  committedAt: "2026-11-03T12:01:00Z",
};

const oracleView = { status: "confirmed", txHash: COMMIT_TX, blockNumber: 16, chainId: 4663, oracleAddress: ADDRESSES.oracle };

function job(status: string, round: number | null) {
  return {
    status,
    attempt: status === "queued" ? 0 : 1,
    progress: round === null ? null : { round, rounds: 10 },
    queuedAt: "2026-11-03T12:00:00Z",
    startedAt: status === "queued" ? null : "2026-11-03T12:00:05Z",
    finishedAt: null,
    refund: null,
  };
}

/** GET /v1/runs/:runId of a run that is playing the given round of 10. */
export function runningStatus(round: number) {
  return { run: null, job: job("running", round), oracle: null, disclaimer: DISCLAIMER };
}

export function quotedOrder(address: string): Order {
  return {
    orderId: ORDER_ID,
    status: "quoted",
    address,
    token: { address: ADDRESSES.usdg, symbol: "USDG", decimals: 6 },
    amount: "1000000",
    priceUsd: 1,
    estimatedCostUsd: 0.17,
    discountBps: 0,
    createdAt: "2026-11-03T12:00:00Z",
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    paidAt: null,
    runId: null,
    chainId: 4663,
    paymentRouter: ADDRESSES.router,
    run: { title: "Fictional token FIZZ lists", agents: 50, rounds: 10, listed: true },
  };
}

export interface ApiLog {
  requests: { method: string; path: string; body: unknown; auth: string | null }[];
}

/** Answer the web app's API calls from the golden run, as the Worker would. */
export async function stubApi(page: Page): Promise<ApiLog> {
  const log: ApiLog = { requests: [] };
  const account: Account = { keys: [], balanceUsd: 0, entries: [], topUpUsd: 0 };
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = request.postData() ? JSON.parse(request.postData()!) : null;
    log.requests.push({ method: request.method(), path: url.pathname, body, auth: request.headers().authorization ?? null });
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(value) });
    if (url.pathname.startsWith("/v1/keys") || url.pathname.startsWith("/v1/balance")) {
      return accountAnswer(account, request.method(), url.pathname, body, json);
    }
    return answer(url, body, json, route, cors);
  });
  return log;
}

interface Account {
  keys: { id: string; label: string | null; prefix: string; createdAt: string; lastUsedAt: string | null }[];
  balanceUsd: number;
  entries: { id: string; deltaUsd: number; reason: string; runId: string | null; createdAt: string }[];
  topUpUsd: number;
}

const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function topUpView(account: Account, paid: boolean) {
  return {
    orderId: ORDER_ID,
    status: paid ? "paid" : "quoted",
    address: WALLET,
    token: { address: ADDRESSES.usdg, symbol: "USDG", decimals: 6 },
    amount: String(Math.round(account.topUpUsd * 1_000_000)),
    amountUsd: account.topUpUsd,
    creditedUsd: paid ? account.topUpUsd : null,
    createdAt: "2026-11-03T12:00:00Z",
    expiresAt: "2100-01-01T00:00:00Z",
    paidAt: paid ? "2026-11-03T12:02:00Z" : null,
    chainId: 4663,
    paymentRouter: ADDRESSES.router,
  };
}

/** API keys and the balance, as the Worker would keep them for one wallet. */
function accountAnswer(
  account: Account,
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  json: (value: unknown, status?: number) => Promise<void>,
) {
  if (path === "/v1/keys" && method === "GET") return json({ keys: account.keys });
  if (path === "/v1/keys" && method === "POST") {
    const key = `hyvo_${"k".repeat(43)}`;
    const view = {
      id: `key_${account.keys.length + 1}`,
      label: (body?.label as string | undefined) ?? null,
      prefix: key.slice(0, 12),
      createdAt: "2026-11-03T12:00:00Z",
      lastUsedAt: null,
    };
    account.keys.unshift(view);
    return json({ key, apiKey: view }, 201);
  }
  if (path.startsWith("/v1/keys/") && method === "DELETE") {
    account.keys = account.keys.filter((key) => key.id !== path.slice("/v1/keys/".length));
    return json({ ok: true });
  }
  if (path === "/v1/balance") return json({ address: WALLET, balanceUsd: account.balanceUsd, entries: account.entries });
  if (path === "/v1/balance/topups") {
    account.topUpUsd = Number(body?.amountUsd);
    return json({ topUp: topUpView(account, false) }, 201);
  }
  if (path === `/v1/balance/topups/${ORDER_ID}/payment`) {
    account.balanceUsd += account.topUpUsd;
    account.entries.unshift({ id: "be_1", deltaUsd: account.topUpUsd, reason: "topup", runId: null, createdAt: "2026-11-03T12:02:00Z" });
    return json({ topUp: topUpView(account, true), check: "paid", message: "Payment confirmed. The balance is credited." });
  }
  return json({ error: { code: "not_found", message: "no such endpoint" } }, 404);
}

async function answer(
  url: URL,
  body: Record<string, unknown> | null,
  json: (value: unknown, status?: number) => Promise<void>,
  route: Route,
  cors: Record<string, string>,
) {
  const path = url.pathname;
  if (path === "/v1/health") {
    return json({
      ok: true,
      version: "test",
      features: { payments: true, oracle: true, holder: false, clone: true },
      limits: { minAgents: 10, maxAgents: 500, minRounds: 3, maxRounds: 30, maxDecisions: 840 },
    });
  }
  if (path === "/v1/runs/featured") return json({ run: summary, disclaimer: DISCLAIMER });
  if (path === "/v1/runs") return json({ runs: [summary], nextCursor: null, disclaimer: DISCLAIMER });
  if (path === `/v1/runs/${golden.runId}`) return json({ run: summary, job: null, oracle: oracleView, disclaimer: DISCLAIMER });
  if (path === `/v1/runs/${RUNNING_ID}`) return json(runningStatus(4));
  if (path === `/v1/runs/${NEW_RUN_ID}`) return json({ run: null, job: job("queued", null), oracle: null, disclaimer: DISCLAIMER });
  if (path === `/v1/runs/${golden.runId}/artifact`) {
    return json({ url: `${API}/v1/artifacts/${golden.runId}/run.json?exp=4102444800&sig=${"0".repeat(64)}`, expiresAt: "2100-01-01T00:00:00Z" });
  }
  if (path === `/v1/artifacts/${golden.runId}/run.json`) {
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: goldenText });
  }
  if (path === "/v1/oracle") {
    return json({ chainId: 4663, oracleAddress: ADDRESSES.oracle, entries: [goldenEntry], nextCursor: null, disclaimer: DISCLAIMER });
  }
  if (path === "/v1/auth/siwe/nonce") return json({ nonce: "abcdefghijklmnopqrstuvwx", expiresAt: "2100-01-01T00:00:00Z" }, 201);
  if (path === "/v1/auth/siwe/verify") {
    const address = /0x[0-9a-fA-F]{40}/.exec(String(body?.message ?? ""))?.[0] ?? "";
    return json({ token: "t".repeat(43), address, expiresAt: "2100-01-01T00:00:00Z", admin: false }, 201);
  }
  if (path === "/v1/me") {
    return json({
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      admin: false,
      holder: {
        enabled: false,
        eligible: false,
        minBalance: "0",
        balance: null,
        balance24hAgo: null,
        freeRunsPerMonth: 0,
        freeRunsLeft: 0,
        discountBps: 0,
        freeRunMax: { agents: 50, rounds: 10 },
      },
    });
  }
  if (path === "/v1/quotes") return json({ order: quotedOrder("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") }, 201);
  if (path === `/v1/orders/${ORDER_ID}/payment`) {
    const order = { ...quotedOrder("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"), status: "paid", paidAt: "2026-11-03T12:02:00Z", runId: NEW_RUN_ID };
    return json({ order, check: "paid", message: "Payment confirmed. The run is queued." });
  }
  return json({ error: { code: "not_found", message: "unknown run" } }, 404);
}
