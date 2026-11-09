/** The Hyvo API client (docs/API.md). Every response is parsed with the shared zod schemas. */
import {
  AdminOverviewResponse,
  ArtifactResponse,
  BalanceResponse,
  CalibrationResponse,
  CreateKeyResponse,
  CloneResponse,
  CreateRunResponse,
  DryRunListResponse,
  DryRunReport,
  DryRunResponse,
  ErrorResponse,
  FeaturedRunResponse,
  HealthResponse,
  KeyListResponse,
  MeResponse,
  NonceResponse,
  OracleLedgerResponse,
  OracleRunResponse,
  OrderResponse,
  PaymentCheckResponse,
  RunListResponse,
  RunResponse,
  RunV1,
  SessionResponse,
  TopUpCheckResponse,
  TopUpResponse,
  TrackedResponse,
  WatchlistResponse,
  PrepaidRunRequest,
  type DryRunRequest,
  type QuestionOutcome,
  type QuoteRequest,
  type RunSummary,
} from "@hyvo/schema";
import { z } from "zod";

export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || "http://127.0.0.1:8787").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "",
  ) {
    super(message);
  }
}

async function getJson<T extends z.ZodType>(url: string, schema: T): Promise<z.infer<T>> {
  return send(url, schema);
}

async function send<T extends z.ZodType>(
  url: string,
  schema: T,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<z.infer<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, "The Hyvo API cannot be reached. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorResponse.safeParse(body);
    throw new ApiError(
      response.status,
      parsed.success ? parsed.data.error.message : "The Hyvo API had a problem. Try again in a moment.",
      parsed.success ? parsed.data.error.code : "",
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(response.status, "The Hyvo API sent an answer this page cannot read. Try reloading the page.");
  return parsed.data;
}

export async function fetchFeatured(): Promise<RunSummary | null> {
  try {
    return (await getJson(`${API_URL}/v1/runs/featured`, FeaturedRunResponse)).run;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function fetchRuns(cursor?: string | null, limit = 20) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return getJson(`${API_URL}/v1/runs?${query}`, RunListResponse);
}

/** A run's status: its published summary, its job while it is queued or running, its oracle commit. */
export function fetchRunStatus(runId: string): Promise<RunResponse> {
  return getJson(`${API_URL}/v1/runs/${encodeURIComponent(runId)}`, RunResponse);
}

/** A fresh signed link to a published run's exact run.json; it expires after a few minutes. */
export function fetchArtifactLink(runId: string) {
  return getJson(`${API_URL}/v1/runs/${encodeURIComponent(runId)}/artifact`, ArtifactResponse);
}

const ARTIFACT_TRIES = 6;
const ARTIFACT_RETRY_MS = 15_000;
const documents = new Map<string, Promise<RunV1>>();

/** The run.json of a published run, through its signed artifact link (cached per page load). */
export function fetchRunDocument(runId: string): Promise<RunV1> {
  let cached = documents.get(runId);
  if (!cached) {
    cached = (async () => {
      const link = await getJson(`${API_URL}/v1/runs/${encodeURIComponent(runId)}/artifact`, ArtifactResponse);
      // Storage reaches other locations up to a minute after a publish: 503 means ask again.
      for (let attempt = 1; ; attempt++) {
        try {
          return await getJson(link.url, RunV1);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 503 || attempt >= ARTIFACT_TRIES) throw error;
          await new Promise((done) => setTimeout(done, ARTIFACT_RETRY_MS));
        }
      }
    })();
    cached.catch(() => documents.delete(runId));
    documents.set(runId, cached);
  }
  return cached;
}

export function fetchHealth() {
  return getJson(`${API_URL}/v1/health`, HealthResponse);
}

// --- sign-in, quotes, payments --------------------------------------------------------------

export function requestNonce() {
  return send(`${API_URL}/v1/auth/siwe/nonce`, NonceResponse, { body: {} });
}

export function verifySignIn(message: string, signature: string) {
  return send(`${API_URL}/v1/auth/siwe/verify`, SessionResponse, { body: { message, signature } });
}

export function fetchMe(token: string) {
  return send(`${API_URL}/v1/me`, MeResponse, { token });
}

// --- HYVO holder utilities: lists kept with a holder's account --------------------------------

export function fetchWatchlist(token: string) {
  return send(`${API_URL}/v1/account/watchlist`, WatchlistResponse, { token });
}

export function saveWatchlist(token: string, tokens: readonly string[]) {
  return send(`${API_URL}/v1/account/watchlist`, WatchlistResponse, { token, method: "PUT", body: { tokens } });
}

export function fetchTracked(token: string) {
  return send(`${API_URL}/v1/account/tracked`, TrackedResponse, { token });
}

export function saveTracked(token: string, wallets: readonly string[]) {
  return send(`${API_URL}/v1/account/tracked`, TrackedResponse, { token, method: "PUT", body: { wallets } });
}

export function requestQuote(token: string, request: QuoteRequest) {
  return send(`${API_URL}/v1/quotes`, OrderResponse, { token, body: request });
}

export function fetchOrder(token: string, orderId: string) {
  return send(`${API_URL}/v1/orders/${orderId}`, OrderResponse, { token });
}

export function checkPayment(token: string, orderId: string, txHash: string) {
  return send(`${API_URL}/v1/orders/${orderId}/payment`, PaymentCheckResponse, { token, body: { txHash } });
}

export function createFreeRun(token: string, request: QuoteRequest) {
  return send(`${API_URL}/v1/runs`, CreateRunResponse, { token, body: { credit: true, ...request } });
}

// --- API keys and the prepaid balance -------------------------------------------------------

export function fetchApiKeys(token: string) {
  return send(`${API_URL}/v1/keys`, KeyListResponse, { token });
}

export function createApiKey(token: string, label: string) {
  return send(`${API_URL}/v1/keys`, CreateKeyResponse, { token, body: label ? { label } : {} });
}

export function revokeApiKey(token: string, id: string) {
  return send(`${API_URL}/v1/keys/${encodeURIComponent(id)}`, z.object({ ok: z.literal(true) }), { token, method: "DELETE" });
}

export function fetchBalance(token: string) {
  return send(`${API_URL}/v1/balance`, BalanceResponse, { token });
}

export function requestTopUp(token: string, amountUsd: number) {
  return send(`${API_URL}/v1/balance/topups`, TopUpResponse, { token, body: { amountUsd } });
}

export function checkTopUp(token: string, orderId: string, txHash: string) {
  return send(`${API_URL}/v1/balance/topups/${orderId}/payment`, TopUpCheckResponse, { token, body: { txHash } });
}

// --- oracle and admin -----------------------------------------------------------------------

export function fetchOracleLedger(cursor?: string | null) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return getJson(`${API_URL}/v1/oracle${query}`, OracleLedgerResponse);
}

export function fetchOracleRun(runId: string) {
  return getJson(`${API_URL}/v1/oracle/${encodeURIComponent(runId)}`, OracleRunResponse);
}

export function createDryRun(token: string, body: DryRunRequest) {
  return send(`${API_URL}/v1/dryruns`, DryRunResponse, { token, body });
}

export function fetchDryRuns(token: string) {
  return send(`${API_URL}/v1/dryruns`, DryRunListResponse, { token });
}

export function fetchDryRun(token: string, runId: string) {
  return send(`${API_URL}/v1/dryruns/${encodeURIComponent(runId)}`, DryRunResponse, { token });
}

export function fetchDryRunReport(token: string, runId: string) {
  return send(`${API_URL}/v1/dryruns/${encodeURIComponent(runId)}/report`, DryRunReport, { token });
}

export function fetchClone(token: string) {
  return send(`${API_URL}/v1/clones/me`, CloneResponse, { token });
}

export function buildClone(token: string) {
  return send(`${API_URL}/v1/clones/me`, CloneResponse, { token, method: "POST" });
}

export function deleteClone(token: string) {
  return send(`${API_URL}/v1/clones/me`, z.null(), { token, method: "DELETE" });
}

/** A run paid from the balance: `{ balance: true, ... }`. */
export function startRunFromBalance(token: string, body: z.input<typeof PrepaidRunRequest>) {
  return send(`${API_URL}/v1/runs`, CreateRunResponse, { token, body });
}

export function fetchCalibration() {
  return getJson(`${API_URL}/v1/calibration`, CalibrationResponse);
}

export function resolveQuestion(token: string, runId: string, body: { outcome: QuestionOutcome; note: string; evidenceUrl?: string }) {
  return send(`${API_URL}/v1/admin/questions/${encodeURIComponent(runId)}/resolve`, z.object({ runId: z.string() }), { token, body });
}

export function fetchAdminOverview(token: string) {
  return send(`${API_URL}/v1/admin/overview`, AdminOverviewResponse, { token });
}

export function recordRefund(token: string, id: string, txHash: string, note: string) {
  return send(`${API_URL}/v1/admin/refunds/${encodeURIComponent(id)}`, z.object({ refund: z.unknown() }), {
    token,
    body: note ? { txHash, note } : { txHash },
  });
}

export function setQueuePaused(token: string, paused: boolean) {
  return send(`${API_URL}/v1/admin/queue`, z.object({ paused: z.boolean() }), { token, body: { paused } });
}
