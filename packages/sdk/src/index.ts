/**
 * A client for the Hyvo API (docs/API.md). It checks every answer against the shared schemas, and `verifyRun` proves a
 * run from the file and the chain instead of taking the API's word for it.
 *
 * Results are synthetic crowd reactions, not trading signals.
 */
import {
  AskResponse,
  ArtifactResponse,
  BalanceResponse,
  CreateRunResponse,
  CreateWebhookResponse,
  DryRunListResponse,
  DryRunReport,
  DryRunResponse,
  FeaturedRunResponse,
  HealthResponse,
  OracleRunResponse,
  OrderResponse,
  PaymentCheckResponse,
  RunListResponse,
  RunResponse,
  RunV1,
  TopUpCheckResponse,
  TopUpResponse,
  WebhookDeliveryListResponse,
  WebhookEvent,
  WebhookListResponse,
  runIdToBytes32,
  verifyRunHash,
  type DryRunRequest,
  type DryRunView,
  type MixInput,
  type OnChainCommit,
  type ScenarioInput,
  type WebhookEventType,
} from "@hyvo/schema";

export type { DryRunReport, DryRunView, RunV1 } from "@hyvo/schema";

export interface HyvoOptions {
  /** The API's base URL, such as https://hyvo-api.artallm.workers.dev. */
  baseUrl: string;
  /** `hyvo_…`, for what spends a balance. Reading runs needs none. */
  apiKey?: string;
  fetch?: typeof fetch;
}

/** An answer from the API that is not a success. */
export class HyvoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS: number | null,
  ) {
    super(message);
    this.name = "HyvoApiError";
  }
}

export interface RunRequest {
  scenario: ScenarioInput;
  agents: number;
  rounds: number;
  mix?: MixInput | null;
  listed?: boolean;
}

export interface VerifyOptions {
  /**
   * An RPC of the chain, to read the commit from the chain itself. Without it, `onChain` is what the API read, which is
   * only as good as the API's word.
   */
  rpcUrl?: string;
}

export interface VerifyResult {
  runId: string;
  /** True when the file hashes to its hash and, if there is a commit, the chain holds that hash. */
  ok: boolean;
  hash: string;
  /** What the file hashes to, computed here. */
  recomputed: string;
  fileMatches: boolean;
  /** Where `onChain` came from. */
  source: "chain" | "api" | null;
  onChain: Pick<OnChainCommit, "reportHash" | "scenarioHash" | "committedAt"> | null;
  /** null: no commit, or it could not be read. */
  chainMatches: boolean | null;
  disclaimer: string;
}

type Parser<T> = { parse(value: unknown): T };

export class Hyvo {
  private readonly base: string;
  private readonly key: string | undefined;
  private readonly send: typeof fetch;

  constructor(options: HyvoOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.key = options.apiKey;
    this.send = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(schema: Parser<T>, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    const response = await this.send(`${this.base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    if (!response.ok) throw apiError(response, text);
    return schema.parse(JSON.parse(text));
  }

  // --- reading ---------------------------------------------------------------------------------

  health() {
    return this.request(HealthResponse, "/v1/health");
  }

  listRuns(options: { limit?: number; cursor?: string } = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    return this.request(RunListResponse, `/v1/runs${query.size ? `?${query}` : ""}`);
  }

  featuredRun() {
    return this.request(FeaturedRunResponse, "/v1/runs/featured");
  }

  getRun(runId: string) {
    return this.request(RunResponse, `/v1/runs/${encodeURIComponent(runId)}`);
  }

  /** Poll until a run is published or has failed. */
  async waitForRun(runId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<RunResponse> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const status = await this.getRun(runId);
      if (status.run || status.job?.status === "failed") return status;
      if (Date.now() >= deadline) throw new Error(`run ${runId} is still ${status.job?.status ?? "unknown"} after the timeout`);
      await new Promise((done) => setTimeout(done, options.intervalMs ?? 15_000));
    }
  }

  /** The exact published bytes of a run. */
  async fetchRunBytes(runId: string): Promise<string> {
    const { url } = await this.request(ArtifactResponse, `/v1/runs/${encodeURIComponent(runId)}/artifact`);
    const response = await this.send(url);
    const text = await response.text();
    if (!response.ok) throw apiError(response, text);
    return text;
  }

  /** A run's full record, checked against the run.json format. */
  async fetchRun(runId: string): Promise<RunV1> {
    return RunV1.parse(JSON.parse(await this.fetchRunBytes(runId)));
  }

  /**
   * Prove a run: recompute its hash from the file, and compare it with the commit on the chain. With `rpcUrl` the chain is
   * read directly, so the API does not need to be trusted at all.
   */
  async verifyRun(runId: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    const run = await this.fetchRun(runId);
    const check = verifyRunHash(run);
    let commit: OracleRunResponse | null = null;
    try {
      commit = await this.request(OracleRunResponse, `/v1/oracle/${encodeURIComponent(runId)}`);
    } catch (error) {
      if (!(error instanceof HyvoApiError) || error.status !== 404) throw error;
    }
    let onChain: VerifyResult["onChain"] = null;
    let source: VerifyResult["source"] = null;
    if (options.rpcUrl && commit?.oracleAddress) {
      onChain = await readCommit(this.send, options.rpcUrl, commit.oracleAddress, runIdToBytes32(runId));
      source = "chain";
    } else if (commit?.onChain) {
      onChain = commit.onChain;
      source = "api";
    }
    const chainMatches = onChain ? onChain.reportHash === check.expected : null;
    return {
      runId,
      ok: check.ok && chainMatches !== false && (commit === null || chainMatches === true),
      hash: run.hash,
      recomputed: check.expected,
      fileMatches: check.ok,
      source,
      onChain,
      chainMatches,
      disclaimer: run.report.disclaimer,
    };
  }

  // --- paying and running ----------------------------------------------------------------------

  balance() {
    return this.request(BalanceResponse, "/v1/balance");
  }

  /** Ask to top up; pay the answer through PaymentRouter (`pay(orderId, token, amount)`). */
  topUp(amountUsd: number) {
    return this.request(TopUpResponse, "/v1/balance/topups", { body: { amountUsd } });
  }

  checkTopUp(orderId: string, txHash: string) {
    return this.request(TopUpCheckResponse, `/v1/balance/topups/${orderId}/payment`, { body: { txHash } });
  }

  /** Start a run paid from the balance. `requestId` makes a retry safe: it pays once. */
  createRun(request: RunRequest & { requestId?: string }) {
    return this.request(CreateRunResponse, "/v1/runs", { body: { balance: true, ...request } });
  }

  /** Price a run and get an order to pay through PaymentRouter. */
  quote(request: RunRequest) {
    return this.request(OrderResponse, "/v1/quotes", { body: request });
  }

  getOrder(orderId: string) {
    return this.request(OrderResponse, `/v1/orders/${orderId}`);
  }

  checkPayment(orderId: string, txHash: string) {
    return this.request(PaymentCheckResponse, `/v1/orders/${orderId}/payment`, { body: { txHash } });
  }

  /** Ask one agent of a published run, or `report`; paid per call from the balance. */
  ask(runId: string, agentId: string, question: string) {
    return this.request(AskResponse, `/v1/runs/${encodeURIComponent(runId)}/ask`, { body: { agentId, question } });
  }

  // --- Dry Runs --------------------------------------------------------------------------------

  /** Have a crowd of synthetic users try a contract, paid from the balance. `requestId` makes a retry safe: it pays once. */
  createDryRun(request: Omit<DryRunRequest, "balance">) {
    return this.request(DryRunResponse, "/v1/dryruns", { body: { balance: true, ...request } });
  }

  listDryRuns() {
    return this.request(DryRunListResponse, "/v1/dryruns");
  }

  getDryRun(runId: string) {
    return this.request(DryRunResponse, `/v1/dryruns/${encodeURIComponent(runId)}`);
  }

  /** Poll until a Dry Run has its report or has failed. */
  async waitForDryRun(runId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<DryRunView> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const { dryRun } = await this.getDryRun(runId);
      if (dryRun.status === "complete" || dryRun.status === "failed") return dryRun;
      if (Date.now() >= deadline) throw new Error(`Dry Run ${runId} is still ${dryRun.status} after the timeout`);
      await new Promise((done) => setTimeout(done, options.intervalMs ?? 15_000));
    }
  }

  /** A Dry Run's report, refused if the file does not match its own hash. */
  async fetchDryRunReport(runId: string): Promise<DryRunReport> {
    const report = await this.request(DryRunReport, `/v1/dryruns/${encodeURIComponent(runId)}/report`);
    if (!verifyRunHash(report as unknown as Record<string, unknown>).ok) throw new Error(`the report of ${runId} does not match its hash`);
    return report;
  }

  // --- webhooks --------------------------------------------------------------------------------

  /** The answer holds the signing secret, shown this once. */
  createWebhook(url: string, events: WebhookEventType[]) {
    return this.request(CreateWebhookResponse, "/v1/webhooks", { body: { url, events } });
  }

  listWebhooks() {
    return this.request(WebhookListResponse, "/v1/webhooks");
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request({ parse: (value) => value }, `/v1/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  webhookDeliveries(id: string) {
    return this.request(WebhookDeliveryListResponse, `/v1/webhooks/${encodeURIComponent(id)}/deliveries`);
  }
}

function apiError(response: Response, text: string): HyvoApiError {
  let code = "unknown";
  let message = `the API answered ${response.status}`;
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // not JSON: keep the status
  }
  const retry = Number(response.headers.get("Retry-After"));
  return new HyvoApiError(response.status, code, message, Number.isFinite(retry) && retry > 0 ? retry : null);
}

// --- the chain, without a chain library --------------------------------------------------------

/** `getCommit(bytes32)` of HyvoOracle. */
export const GET_COMMIT_SELECTOR = "0x8784ea96";

async function readCommit(send: typeof fetch, rpcUrl: string, oracle: string, runIdBytes32: string): Promise<VerifyResult["onChain"]> {
  const response = await send(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: oracle, data: GET_COMMIT_SELECTOR + runIdBytes32.slice(2) }, "latest"],
    }),
  });
  const { result, error } = (await response.json()) as { result?: string; error?: { message?: string } };
  if (error || !result) throw new Error(`the chain could not be read: ${error?.message ?? "no result"}`);
  return decodeCommit(result);
}

/** `(bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint64 committedAt, uint64 resolvedAt, bytes32 outcomeHash)`. */
export function decodeCommit(data: string): VerifyResult["onChain"] {
  const words = data.slice(2).match(/.{64}/g) ?? [];
  if (words.length < 6) return null;
  const committedAt = Number(BigInt(`0x${words[3]}`));
  if (committedAt === 0) return null; // this run was never committed
  return {
    reportHash: `0x${words[0]}` as `0x${string}`,
    scenarioHash: `0x${words[1]}` as `0x${string}`,
    committedAt,
  };
}

// --- webhooks: the receiver's side --------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Check a delivery's `X-Hyvo-Signature` and parse its body; null when it does not hold. `body` must be the raw request body.
 * `toleranceS` refuses an old delivery replayed later: a repeat of a failed delivery is signed again, so it passes.
 */
export async function verifyWebhook(
  secret: string,
  signature: string,
  body: string,
  options: { toleranceS?: number; nowS?: number } = {},
): Promise<WebhookEvent | null> {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);
  if (!match) return null;
  const timestamp = Number(match[1]);
  const now = options.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceS ?? 300)) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const given = new Uint8Array(match[2]!.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
  const valid = await crypto.subtle.verify("HMAC", key, given, encoder.encode(`${timestamp}.${body}`));
  if (!valid) return null;
  return WebhookEvent.parse(JSON.parse(body));
}
