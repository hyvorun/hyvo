/**
 * An OpenAI-compatible chat endpoint over Cloudflare Workers AI, for the engine
 * (`LLM_BASE_URL=<api>/internal/llm/v1`, `LLM_API_KEY=<LLM_TOKEN>`). The binding needs no API key
 * and stays inside Cloudflare's free allocation on the Workers Free plan; past it, calls fail until the allowance
 * comes back (docs/RUNBOOK.md, "What the free plans allow").
 *
 * It has its own token, not the runner's: an LLM key travels to whatever LLM_BASE_URL says and sits
 * in the engine's process, and neither should reach the job queue.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { runAi } from "../lib/ai";
import { nowS } from "../lib/clock";
import { ApiError } from "../lib/errors";
import { sameSecret } from "../lib/signing";

export const llm = new Hono<AppEnv>();

const MODEL = /^@cf\/[a-z0-9._/-]{1,100}$/;
interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  response_format?: unknown;
}

llm.use("*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!c.env.LLM_TOKEN || !(await sameSecret(token, c.env.LLM_TOKEN))) {
    throw new ApiError(401, "unauthorized", "a valid LLM token is required");
  }
  await next();
});

llm.post("/v1/chat/completions", async (c) => {
  if (!c.env.AI) throw new ApiError(503, "llm_disabled", "Workers AI is not bound on this API");
  let body: ChatRequest;
  try {
    body = await c.req.json<ChatRequest>();
  } catch {
    throw new ApiError(400, "bad_request", "the body must be JSON");
  }
  const { model, messages } = body;
  if (typeof model !== "string" || !MODEL.test(model)) throw new ApiError(400, "bad_request", "model must be a Workers AI model (@cf/...)");
  if (!Array.isArray(messages) || messages.length === 0) throw new ApiError(400, "bad_request", "messages must be a list");

  const input: Record<string, unknown> = { messages };
  if (typeof body.temperature === "number") input.temperature = body.temperature;
  if (typeof body.max_tokens === "number") input.max_tokens = body.max_tokens;
  if (body.response_format && typeof body.response_format === "object") input.response_format = body.response_format;

  const result = await runAi(c.env.AI, model, input);
  // Some models answer in the OpenAI shape already.
  if (Array.isArray(result.choices)) return c.json(result);
  const content = typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? "");
  return c.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: nowS(),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: result.usage?.prompt_tokens ?? 0,
      completion_tokens: result.usage?.completion_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
    },
  });
});
