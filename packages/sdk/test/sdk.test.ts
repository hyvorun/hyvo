import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DISCLAIMER, hashRun, runIdToBytes32 } from "@hyvo/schema";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { decodeCommit, GET_COMMIT_SELECTOR, Hyvo, HyvoApiError, verifyWebhook } from "../src/index";

const API = "https://api.test";
const RPC = "https://rpc.test";
const ORACLE = "0x2FEDc123c38B069cf78e5915852A61022E347642";
const goldenText = readFileSync(new URL("../../../fixtures/golden-run.json", import.meta.url), "utf-8");
const golden = JSON.parse(goldenText);
const RUN_ID: string = golden.runId;
const HASH: `0x${string}` = golden.hash;
const OTHER = `0x${"11".repeat(32)}` as const;
const ZERO = `0x${"00".repeat(32)}` as const;

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function commitWords(reportHash: `0x${string}`, committedAt: bigint): string {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "bytes32" },
        ],
      },
    ],
    [[reportHash, OTHER, 0n, committedAt, 0n, ZERO]],
  );
}

const entry = {
  runId: RUN_ID,
  runIdBytes32: runIdToBytes32(RUN_ID),
  reportHash: HASH,
  scenarioHash: OTHER,
  title: "t",
  status: "confirmed",
  txHash: OTHER,
  blockNumber: 5,
  committedAt: "2026-11-05T00:00:00Z",
};

function oracleAnswer(reportHash: string) {
  return {
    entry,
    chainId: 4663,
    oracleAddress: ORACLE,
    onChain: { reportHash, scenarioHash: OTHER, resolvesAt: 0, committedAt: 100, resolvedAt: 0, outcomeHash: ZERO },
    matches: reportHash === HASH,
    disclaimer: DISCLAIMER,
  };
}

/** A stand-in API serving the golden run, with a chain that holds `chainHash`. */
function stage(options: { bytes?: string; apiHash?: string; chainHash?: `0x${string}`; committed?: boolean; extra?: Handler } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const handler: Handler = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(RPC)) {
      const { params, method } = JSON.parse(String(init.body));
      expect(method).toBe("eth_call");
      expect(params[0].to).toBe(ORACLE);
      expect(params[0].data).toBe(GET_COMMIT_SELECTOR + runIdToBytes32(RUN_ID).slice(2));
      const committed = options.committed !== false;
      return json({ jsonrpc: "2.0", id: 1, result: commitWords(options.chainHash ?? HASH, committed ? 100n : 0n) });
    }
    const path = url.slice(API.length);
    if (path === `/v1/runs/${RUN_ID}/artifact`) return json({ url: `${API}/bytes`, expiresAt: "2026-11-05T00:00:00Z" });
    if (path === "/bytes") return new Response(options.bytes ?? goldenText);
    if (path === `/v1/oracle/${RUN_ID}`) return options.apiHash === "none" ? json({ error: { code: "not_found", message: "no commit" } }, 404) : json(oracleAnswer(options.apiHash ?? HASH));
    if (options.extra) return options.extra(url, init);
    return json({ error: { code: "not_found", message: "no such endpoint" } }, 404);
  };
  const fetcher = ((url: string | URL | Request, init: RequestInit = {}) => Promise.resolve(handler(String(url), init))) as typeof fetch;
  return { client: new Hyvo({ baseUrl: `${API}/`, apiKey: "hyvo_test", fetch: fetcher }), calls };
}

describe("verifyRun", () => {
  it("passes when the file and the chain agree", async () => {
    const result = await stage().client.verifyRun(RUN_ID, { rpcUrl: RPC });
    expect(result).toMatchObject({ ok: true, fileMatches: true, chainMatches: true, source: "chain", recomputed: HASH, hash: HASH });
    expect(result.disclaimer).toBe(DISCLAIMER);
  });

  it("does not take the API's word: a chain that holds another hash fails, whatever the API says", async () => {
    const result = await stage({ chainHash: OTHER, apiHash: HASH }).client.verifyRun(RUN_ID, { rpcUrl: RPC });
    expect(result).toMatchObject({ ok: false, chainMatches: false, source: "chain" });
  });

  it("catches a file that was changed after it was hashed", async () => {
    const changed = structuredClone(golden);
    changed.report.summary = "A different story.";
    const result = await stage({ bytes: JSON.stringify(changed) }).client.verifyRun(RUN_ID, { rpcUrl: RPC });
    expect(result.fileMatches).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.recomputed).toBe(hashRun(changed));
    expect(result.chainMatches).toBe(false);
  });

  it("says where the commit came from when no RPC is given", async () => {
    const result = await stage().client.verifyRun(RUN_ID);
    expect(result).toMatchObject({ ok: true, source: "api", chainMatches: true });
  });

  it("does not call a run proven when its commit cannot be found on the chain", async () => {
    const result = await stage({ committed: false }).client.verifyRun(RUN_ID, { rpcUrl: RPC });
    expect(result).toMatchObject({ ok: false, onChain: null, chainMatches: null, fileMatches: true });
  });

  it("is plain about a run with no commit: only the file is checked", async () => {
    const result = await stage({ apiHash: "none" }).client.verifyRun(RUN_ID, { rpcUrl: RPC });
    expect(result).toMatchObject({ ok: true, fileMatches: true, onChain: null, chainMatches: null, source: null });
  });
});

describe("the chain call", () => {
  it("uses HyvoOracle's real selector", () => {
    expect(GET_COMMIT_SELECTOR).toBe(toFunctionSelector("getCommit(bytes32)"));
  });

  it("decodes what the contract returns, and nothing from a run never committed", () => {
    expect(decodeCommit(commitWords(HASH, 100n))).toEqual({ reportHash: HASH, scenarioHash: OTHER, committedAt: 100 });
    expect(decodeCommit(commitWords(ZERO, 0n))).toBeNull();
    expect(decodeCommit("0x")).toBeNull();
  });
});

describe("requests", () => {
  it("send the key, and parse the answer", async () => {
    const created = { runId: RUN_ID, job: { status: "queued", attempt: 0, progress: null, queuedAt: "2026-11-05T00:00:00Z", startedAt: null, finishedAt: null, refund: null }, chargedUsd: 1 };
    const { client, calls } = stage({ extra: () => json(created, 201) });
    const answer = await client.createRun({ scenario: { title: "t", seedText: "", events: [] }, agents: 50, rounds: 10, requestId: "bot-attempt-1" });
    expect(answer.chargedUsd).toBe(1);
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect(url).toBe(`${API}/v1/runs`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer hyvo_test");
    expect(JSON.parse(String(init.body))).toMatchObject({ balance: true, requestId: "bot-attempt-1", agents: 50 });
  });

  it("turn an error into something a program can act on", async () => {
    const { client } = stage({ extra: () => json({ error: { code: "insufficient_balance", message: "top up first" } }, 402) });
    const error = await client.balance().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HyvoApiError);
    expect(error).toMatchObject({ status: 402, code: "insufficient_balance", message: "top up first", retryAfterS: null });
  });

  it("keep Retry-After, and survive an error that is not JSON", async () => {
    const limited = stage({ extra: () => json({ error: { code: "rate_limited", message: "slow down" } }, 429, { "Retry-After": "30" }) });
    await expect(limited.client.balance()).rejects.toMatchObject({ retryAfterS: 30, code: "rate_limited" });
    const broken = stage({ extra: () => new Response("<html>", { status: 502 }) });
    await expect(broken.client.balance()).rejects.toMatchObject({ status: 502, code: "unknown" });
  });

  it("refuse an answer that does not match the schema", async () => {
    const { client } = stage({ extra: () => json({ balanceUsd: "lots" }) });
    await expect(client.balance()).rejects.toThrow();
  });

  it("wait for a run until it is published or failed", async () => {
    const job = { attempt: 1, progress: null, queuedAt: "2026-11-05T00:00:00Z", startedAt: null, finishedAt: null, refund: "credited" };
    let polls = 0;
    const { client } = stage({
      extra: () => {
        polls++;
        return json({ run: null, job: { ...job, status: polls < 3 ? "running" : "failed", refund: polls < 3 ? null : "credited" }, oracle: null, disclaimer: DISCLAIMER });
      },
    });
    const status = await client.waitForRun(RUN_ID, { intervalMs: 1 });
    expect(status.job).toMatchObject({ status: "failed", refund: "credited" });
    expect(polls).toBe(3);
  });

  it("give up waiting at the timeout", async () => {
    const job = { status: "queued", attempt: 0, progress: null, queuedAt: "2026-11-05T00:00:00Z", startedAt: null, finishedAt: null, refund: null };
    const { client } = stage({ extra: () => json({ run: null, job, oracle: null, disclaimer: DISCLAIMER }) });
    await expect(client.waitForRun(RUN_ID, { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow("still queued");
  });
});

describe("Dry Runs", () => {
  const reportText = readFileSync(new URL("../../../fixtures/dryrun-sample.json", import.meta.url), "utf-8");
  const report = JSON.parse(reportText);
  const view = (status: string, extra: Record<string, unknown> = {}) => ({
    runId: report.runId,
    title: "A savings vault.",
    status,
    progress: null,
    queuedAt: "2026-11-05T00:00:00Z",
    finishedAt: null,
    chargedUsd: 1,
    hash: null,
    summary: null,
    failReason: null,
    refund: null,
    ...extra,
  });

  it("start from the balance, with what was asked", async () => {
    const { client, calls } = stage({ extra: () => json({ dryRun: view("queued"), disclaimer: DISCLAIMER }, 201) });
    const address = `0x${"1".repeat(40)}`;
    const { dryRun } = await client.createDryRun({ description: "A savings vault.", address, invariants: ["isSolvent"] });
    expect(dryRun.status).toBe("queued");
    expect(calls[0]!.url).toBe(`${API}/v1/dryruns`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ balance: true, description: "A savings vault.", address, invariants: ["isSolvent"] });
  });

  it("list what this wallet asked for", async () => {
    const { client, calls } = stage({ extra: () => json({ dryRuns: [view("complete")], disclaimer: DISCLAIMER }) });
    expect((await client.listDryRuns()).dryRuns).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/dryruns`);
  });

  it("wait until there is a report, or it failed", async () => {
    let polls = 0;
    const { client } = stage({
      extra: () => {
        polls++;
        const status = polls < 3 ? view("running", { progress: { round: polls, rounds: 8 } }) : view("failed", { failReason: "the constructor reverted", refund: "credited" });
        return json({ dryRun: status, disclaimer: DISCLAIMER });
      },
    });
    expect(await client.waitForDryRun(report.runId, { intervalMs: 1 })).toMatchObject({ status: "failed", refund: "credited" });
    expect(polls).toBe(3);
  });

  it("give up waiting at the timeout", async () => {
    const { client } = stage({ extra: () => json({ dryRun: view("queued"), disclaimer: DISCLAIMER }) });
    await expect(client.waitForDryRun(report.runId, { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow("still queued");
  });

  it("fetch a report that matches its hash", async () => {
    const { client, calls } = stage({ extra: () => new Response(reportText) });
    const fetched = await client.fetchDryRunReport(report.runId);
    expect(fetched.findings.map((finding) => finding.title)).toContain("isSolvent() became false");
    expect(calls[0]!.url).toBe(`${API}/v1/dryruns/${report.runId}/report`);
  });

  it("refuse a report changed after it was hashed", async () => {
    const { client } = stage({ extra: () => json({ ...report, description: "Nothing to see here." }) });
    await expect(client.fetchDryRunReport(report.runId)).rejects.toThrow("does not match its hash");
  });
});

describe("verifyWebhook", () => {
  const secret = `whsec_${"ab".repeat(32)}`;
  const event = { id: "evt_1", type: "run.completed", createdAt: "2026-11-05T00:00:00Z", data: { runId: RUN_ID, hash: HASH }, disclaimer: DISCLAIMER };
  const body = JSON.stringify(event);
  const NOW = 1_800_000_000;
  const sign = (at: number, text = body, key = secret) => `t=${at},v1=${createHmac("sha256", key).update(`${at}.${text}`).digest("hex")}`;

  it("accepts a good signature and parses the event", async () => {
    expect(await verifyWebhook(secret, sign(NOW), body, { nowS: NOW })).toMatchObject({ id: "evt_1", type: "run.completed" });
  });

  it.each([
    ["a changed body", () => sign(NOW), `${body} `],
    ["another secret", () => sign(NOW, body, "whsec_other"), body],
    ["an old delivery played again", () => sign(NOW - 301), body],
    ["a signature from the future", () => sign(NOW + 301), body],
    ["nonsense", () => "t=abc,v1=xyz", body],
    ["no signature", () => "", body],
  ])("refuses %s", async (_name, signature, text) => {
    expect(await verifyWebhook(secret, signature(), text, { nowS: NOW })).toBeNull();
  });
});
