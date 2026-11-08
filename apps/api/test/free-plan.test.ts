/** What makes the Worker fit the Workers Free plan: secp256k1 in WebAssembly, LLM through the AI binding. */
import { env } from "cloudflare:test";
import { hashMessage, keccak256, parseSignature, recoverAddress as viemRecover, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { config } from "../src/lib/config";
import { checkDailyCap, quoteRun } from "../src/lib/pricing";
import { addressOfKey, recoverAddress, signHash } from "../src/lib/secp256k1";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(KEY);
const TOKEN = "test-runner-token";

describe("secp256k1 in WebAssembly", () => {
  it("derives the same address as viem", () => {
    expect(addressOfKey(KEY)).toBe(account.address);
  });

  it("recovers what viem signs, with v 27 or 28", async () => {
    for (const message of ["Sign in to Hyvo.", "another message", "x".repeat(500)]) {
      const signature = await account.signMessage({ message });
      expect(recoverAddress(hashMessage(message), signature)).toBe(account.address);
    }
  });

  it("signs what viem verifies, identically (RFC 6979)", async () => {
    const hash = keccak256("0x1234");
    const ours = signHash(hash, KEY);
    const theirs = parseSignature(await account.sign({ hash }));
    expect(ours.r).toBe(theirs.r);
    expect(ours.s).toBe(theirs.s);
    expect(ours.yParity).toBe(theirs.yParity);
    expect(await viemRecover({ hash, signature: ours })).toBe(account.address);
  });

  it("answers null for anything that is not a valid signature", async () => {
    const hash = hashMessage("x");
    const good = await account.signMessage({ message: "x" });
    const bad: Hex[] = [
      "0x",
      "0x1234",
      `0x${"00".repeat(65)}`,
      `0x${"ff".repeat(65)}`, // r and s above the curve order
      `${good.slice(0, 130)}05` as Hex, // recovery id out of range
    ];
    for (const signature of bad) expect(recoverAddress(hash, signature)).toBeNull();
    // A valid signature of another message recovers another address, not an error.
    expect(recoverAddress(hashMessage("y"), good)).not.toBe(account.address);
    // The instance keeps working after refusals.
    expect(recoverAddress(hash, good)).toBe(account.address);
  });

  it("leaves no key in wasm memory after signing", () => {
    signHash(keccak256("0x01"), KEY);
    expect(addressOfKey(KEY)).toBe(account.address);
  });
});

describe("the largest run on the free LLM allowance", () => {
  // The values of production.vars.json.
  const free = {
    ...env,
    COST_PER_AGENT_ROUND_USD: "0.00005",
    REPORT_COST_USD: "0.008",
    DAILY_SPEND_CAP_USD: "0.10",
  } as unknown as Env;

  it("is told by /v1/health and agrees with what a quote accepts", async () => {
    const health = (await (await app.request("https://api.test/v1/health", {}, free)).json()) as {
      limits: { maxDecisions: number };
    };
    expect(health.limits.maxDecisions).toBe(840);
    const cfg = config(free);
    expect(() => checkDailyCap(cfg, quoteRun(cfg, { agents: 84, rounds: 10 }))).not.toThrow();
    expect(() => checkDailyCap(cfg, quoteRun(cfg, { agents: 85, rounds: 10 }))).toThrow(/daily limit/);
    expect(quoteRun(cfg, { agents: 50, rounds: 10 })).toMatchObject({ priceUsd: 1, estimatedCostUsd: 0.033, maxCostUsd: 0.066 });
  });
});

describe("the LLM endpoint over Workers AI", () => {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  afterEach(() => void (calls.length = 0));

  function withAi(answer: unknown | Error): Env {
    const AI = {
      run: async (model: string, input: Record<string, unknown>) => {
        calls.push({ model, input });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { ...env, AI } as unknown as Env;
  }

  function chat(target: Env, body: unknown, token = "test-llm-token") {
    return app.request(
      "https://api.test/internal/llm/v1/chat/completions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      target,
    );
  }

  const request = {
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.8,
    max_tokens: 100,
    response_format: { type: "json_object" },
    stream: true, // dropped: the binding's stream is not what the runner reads
  };

  it("answers in the OpenAI shape, with usage", async () => {
    const target = withAi({ response: "hi", usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    const response = await chat(target, request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.choices[0]).toEqual({ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" });
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    expect(calls).toEqual([
      {
        model: request.model,
        input: {
          messages: request.messages,
          temperature: 0.8,
          max_tokens: 100,
          response_format: request.response_format,
        },
      },
    ]);
  });

  it("passes OpenAI-shaped answers through, and turns object answers into text", async () => {
    const shaped = { choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "length" }], usage: {} };
    expect(await (await chat(withAi(shaped), request)).json()).toEqual(shaped);
    const parsed = (await (await chat(withAi({ response: { a: 1 } }), request)).json()) as Record<string, any>;
    expect(parsed.choices[0].message.content).toBe('{"a":1}');
  });

  it("needs its own token and a Workers AI model", async () => {
    expect((await chat(withAi({ response: "x" }), request, "wrong")).status).toBe(401);
    expect((await chat(withAi({ response: "x" }), request, TOKEN)).status).toBe(401); // the runner's
    const closed = { ...withAi({ response: "x" }), LLM_TOKEN: "" } as Env;
    expect((await chat(closed, request, "")).status).toBe(401);
    expect((await chat(withAi({ response: "x" }), { ...request, model: "gpt-5" })).status).toBe(400);
    expect((await chat(withAi({ response: "x" }), { ...request, messages: [] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("opens nothing else: its token is not a runner token", async () => {
    const response = await app.request(
      "https://api.test/internal/jobs/next",
      { headers: { Authorization: "Bearer test-llm-token" } },
      withAi({ response: "x" }),
    );
    expect(response.status).toBe(401);
  });

  it("says when the free allocation is used up, and when the model fails", async () => {
    const quota = await chat(withAi(new Error("4006: you have used up your daily free allocation of 10,000 neurons")), request);
    expect(quota.status).toBe(429);
    expect(quota.headers.get("Retry-After")).not.toBeNull();
    expect((await chat(withAi(new Error("model overloaded")), request)).status).toBe(502);
  });

  it("is off without the binding", async () => {
    expect((await chat({ ...env, AI: undefined } as Env, request)).status).toBe(503);
  });
});
