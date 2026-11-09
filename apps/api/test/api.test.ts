import { env } from "cloudflare:test";
import {
  ArtifactResponse,
  FeaturedRunResponse,
  hashRun,
  HealthResponse,
  PublishResponse,
  RunListResponse,
  RunResponse,
} from "@hyvo/schema";
import { beforeEach, describe, expect, it } from "vitest";
import goldenText from "../../../fixtures/golden-run.json?raw";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { metaFor } from "./helpers";

const TOKEN = "test-runner-token";
const golden = JSON.parse(goldenText);

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.request(`https://api.test${path}`, init, env);
}

/** `POST /internal/runs/publish`: a line of metadata, then the exact bytes. */
async function publish(
  body: string,
  { token = TOKEN, featured = false, target = env as Env, meta }: { token?: string; featured?: boolean; target?: Env; meta?: unknown } = {},
): Promise<Response> {
  const { hash, sha256, summary } = await metaFor(body);
  const line = JSON.stringify(meta ?? { hash, sha256, summary, ...(featured ? { featured } : {}) });
  return app.request(
    "https://api.test/internal/runs/publish",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: `${line}\n${body}`,
    },
    target,
  );
}

/** A valid copy of the golden run with another runId, title and createdAt (re-hashed). */
function variant(runId: string, createdAt: string): string {
  const run = structuredClone(golden);
  run.runId = runId;
  run.createdAt = createdAt;
  delete run.hash;
  run.hash = hashRun(run);
  return JSON.stringify(run);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM runs");
});

describe("health", () => {
  it("answers ok with the version", async () => {
    const response = await request("/v1/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      version: env.API_VERSION,
      features: { payments: false, oracle: false, holder: false, clone: false },
      limits: { minAgents: 10, maxAgents: 2000, minRounds: 3, maxRounds: 30, maxDecisions: 15_000 },
      holder: null,
      pricing: { multiplier: 2.5, floorUsd: 1, stepUsd: 1, costPerAgentRoundUsd: 0.0003, reportCostUsd: 0.02 },
    });
    expect(HealthResponse.parse(body)).toEqual(body);
  });

  /** The API with a token address and an RPC, and HOLDER_MIN as given. */
  async function holderHealth(holderMin: string | undefined) {
    const target = { ...env, RPC_URLS: "http://chain.test", HYVO_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000a3", HOLDER_MIN: holderMin } as Env;
    return HealthResponse.parse(await (await app.request("https://api.test/v1/health", {}, target)).json());
  }

  it("says what a holder must hold, and for how long, once holder benefits are on", async () => {
    const health = await holderHealth("1000");
    expect(health.features.holder).toBe(true);
    expect(health.holder).toEqual({ min: "1000", decimals: 18, heldForSeconds: 86_400 });
    expect((await holderHealth(" 2.50 ")).holder).toEqual({ min: "2.5", decimals: 18, heldForSeconds: 86_400 });
  });

  it("keeps holder benefits off while no wallet could qualify: a minimum of 0, none, or one that is not a number", async () => {
    for (const holderMin of ["0", "0.0", "", undefined, "1,000", "lots"]) {
      const health = await holderHealth(holderMin);
      expect(health.features.holder, String(holderMin)).toBe(false);
      expect(health.holder, String(holderMin)).toBeNull();
    }
  });

  it("keeps holder benefits off without a token address, whatever the minimum", async () => {
    const target = { ...env, RPC_URLS: "http://chain.test", HYVO_TOKEN_ADDRESS: "", HOLDER_MIN: "1000" } as Env;
    const health = HealthResponse.parse(await (await app.request("https://api.test/v1/health", {}, target)).json());
    expect(health.features.holder).toBe(false);
    expect(health.holder).toBeNull();
  });
});

describe("POST /internal/runs/publish", () => {
  it("requires the runner token", async () => {
    expect((await publish(goldenText, { token: "wrong" })).status).toBe(401);
    const missing = await request("/internal/runs/publish", { method: "POST", body: goldenText });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
  });

  it("publishes the golden run once and is idempotent", async () => {
    const first = await publish(goldenText);
    expect(first.status).toBe(201);
    const body = PublishResponse.parse(await first.json());
    expect(body).toMatchObject({ runId: golden.runId, hash: golden.hash });
    const again = await publish(goldenText);
    expect(again.status).toBe(200);
    expect(PublishResponse.parse(await again.json()).publishedAt).toBe(body.publishedAt);
  });

  it("rejects a different hash for a published runId", async () => {
    expect((await publish(goldenText)).status).toBe(201);
    const run = structuredClone(golden);
    run.report.summary = "A different summary.";
    delete run.hash;
    run.hash = hashRun(run);
    const conflict = await publish(JSON.stringify(run));
    expect(conflict.status).toBe(409);
  });

  it("rejects bytes that are not what the metadata says", async () => {
    const { hash, summary } = await metaFor(goldenText);
    const response = await publish(goldenText, { meta: { hash, sha256: "0".repeat(64), summary } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_run");
  });

  it("rejects metadata that is missing, or for another hash", async () => {
    const { sha256, summary } = await metaFor(goldenText);
    const noLine = await app.request(
      "https://api.test/internal/runs/publish",
      { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{}" },
      env,
    );
    expect(noLine.status).toBe(400);
    expect((await publish(goldenText, { meta: { nope: 1 } })).status).toBe(400);
    expect((await publish(goldenText, { meta: { hash: `0x${"1".repeat(64)}`, sha256, summary } })).status).toBe(400);
  });

  it("rejects a byte order mark, and bytes that are not an object", async () => {
    const { hash, summary } = await metaFor(goldenText);
    const encoder = new TextEncoder();
    for (const bytes of [`\uFEFF${goldenText}`, `[${goldenText}]`]) {
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(bytes)))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const line = JSON.stringify({ hash, sha256, summary });
      const response = await app.request(
        "https://api.test/internal/runs/publish",
        { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: `${line}\n${bytes}` },
        env,
      );
      expect(response.status).toBe(400);
    }
  });

  it("rejects a body over 5 MB", async () => {
    const response = await app.request(
      "https://api.test/internal/runs/publish",
      { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: " ".repeat(5 * 1024 * 1024 + 64 * 1024 + 1) },
      env,
    );
    expect(response.status).toBe(413);
  });

  it("re-checks the run in the Worker only with VERIFY_RUNS_IN_WORKER=1 (Workers Paid)", async () => {
    const wrong = JSON.stringify({ ...golden, hash: `0x${"0".repeat(64)}` });
    const strict = { ...env, VERIFY_RUNS_IN_WORKER: "1" } as Env;
    const checked = await publish(wrong, { target: strict });
    expect(checked.status).toBe(400);
    expect(((await checked.json()) as { error: { code: string } }).error.code).toBe("invalid_run");
    const invalid = await publish(JSON.stringify({ ...golden, version: 2 }), { target: strict });
    expect(invalid.status).toBe(400);
    expect((await publish(goldenText, { target: strict })).status).toBe(201);
  });
});

describe("GET /v1/runs", () => {
  it("lists published runs newest first with cursors", async () => {
    const ids = ["run_01M6FTAPSWS9Q5KVY5BT34XMA1", "run_01M6FTAPSWS9Q5KVY5BT34XMA2", "run_01M6FTAPSWS9Q5KVY5BT34XMA3"];
    for (const [i, id] of ids.entries()) {
      expect((await publish(variant(id, `2026-11-0${i + 1}T10:00:00Z`))).status).toBe(201);
      await env.DB.prepare("UPDATE runs SET published_at = ? WHERE run_id = ?").bind(`2026-11-0${i + 1}T12:00:00Z`, id).run();
    }
    const page1 = RunListResponse.parse(await (await request("/v1/runs?limit=2")).json());
    expect(page1.runs.map((r) => r.runId)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = RunListResponse.parse(
      await (await request(`/v1/runs?limit=2&cursor=${page1.nextCursor}`)).json(),
    );
    expect(page2.runs.map((r) => r.runId)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();
  });

  it("validates limit and cursor", async () => {
    expect((await request("/v1/runs?limit=0")).status).toBe(400);
    expect((await request("/v1/runs?limit=51")).status).toBe(400);
    expect((await request("/v1/runs?cursor=%%%")).status).toBe(400);
  });

  it("serves summaries derived from run.json", async () => {
    await publish(goldenText, { featured: true });
    const body = RunResponse.parse(await (await request(`/v1/runs/${golden.runId}`)).json());
    // Published by hand: there is no job and no oracle commit.
    expect(body.job).toBeNull();
    expect(body.oracle).toBeNull();
    const run = body.run!;
    expect(run).toMatchObject({ runId: golden.runId, hash: golden.hash, featured: true, rounds: 10, crowdSize: 50 });
    expect(run.market.priceStart).toBe(golden.world.initialMarket.price);
    expect(run.sparkline).toHaveLength(11);
  });
});

describe("GET /v1/runs/featured", () => {
  it("is 404 before anything is published", async () => {
    expect((await request("/v1/runs/featured")).status).toBe(404);
  });

  it("prefers a featured run over a newer one", async () => {
    const featured = "run_01M6FTAPSWS9Q5KVY5BT34XMB1";
    const newer = "run_01M6FTAPSWS9Q5KVY5BT34XMB2";
    await publish(variant(featured, "2026-11-01T10:00:00Z"), { featured: true });
    await publish(variant(newer, "2026-11-02T10:00:00Z"));
    const { run } = FeaturedRunResponse.parse(await (await request("/v1/runs/featured")).json());
    expect(run.runId).toBe(featured);
  });
});

describe("GET /v1/runs/:runId", () => {
  it("is 404 for unknown and malformed ids", async () => {
    expect((await request("/v1/runs/run_01M6FTAPSWS9Q5KVY5BT34XMZZ")).status).toBe(404);
    expect((await request("/v1/runs/not-a-run")).status).toBe(404);
  });
});

describe("artifacts", () => {
  it("serves the exact published bytes through a signed link", async () => {
    await publish(goldenText);
    const link = ArtifactResponse.parse(await (await request(`/v1/runs/${golden.runId}/artifact`)).json());
    const url = new URL(link.url);
    const response = await request(url.pathname + url.search);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(await response.text()).toBe(goldenText);
  });

  it("says so when the store has not caught up with a publish yet", async () => {
    await publish(goldenText);
    const link = ArtifactResponse.parse(await (await request(`/v1/runs/${golden.runId}/artifact`)).json());
    const url = new URL(link.url);
    await env.ARTIFACTS.delete(`runs/${golden.runId}/run.json`);
    const response = await request(url.pathname + url.search);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).not.toBeNull();
  });

  it("rejects a tampered or expired link", async () => {
    await publish(goldenText);
    const link = new URL(
      ArtifactResponse.parse(await (await request(`/v1/runs/${golden.runId}/artifact`)).json()).url,
    );
    const sig = link.searchParams.get("sig")!;
    const tampered = `${link.pathname}?exp=${Number(link.searchParams.get("exp")) + 1}&sig=${sig}`;
    expect((await request(tampered)).status).toBe(403);
    expect((await request(`${link.pathname}?exp=1&sig=${sig}`)).status).toBe(403);
  });
});

describe("CORS", () => {
  it("allows only the web origin", async () => {
    const allowed = await request("/v1/health", { headers: { Origin: env.WEB_ORIGIN } });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(env.WEB_ORIGIN);
    const other = await request("/v1/health", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows every origin listed while the site moves to its own domain", async () => {
    const moving = { ...env, WEB_ORIGIN: "https://hyvo.run, https://hyvo.pages.dev" };
    for (const origin of ["https://hyvo.run", "https://hyvo.pages.dev"]) {
      const response = await app.request("/v1/health", { headers: { Origin: origin } }, moving);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
    const other = await app.request("/v1/health", { headers: { Origin: "https://hyvo.run.evil.example" } }, moving);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
