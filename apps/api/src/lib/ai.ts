/** Workers AI, as the Worker's two callers need it: the engine's chat endpoint and questions about a run. */
import { ApiError } from "./errors";

/** Workers AI error when the free allocation is used up, as its message states the code. */
const QUOTA_ERROR = /\b4006\b|daily free allocation/i;

export interface AiResult {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices?: unknown[];
}

export async function runAi(ai: Ai, model: string, input: Record<string, unknown>): Promise<AiResult> {
  try {
    return (await ai.run(model as never, input as never)) as AiResult;
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 300);
    console.warn(JSON.stringify({ level: "warn", event: "llm_failed", model, error: message }));
    if (QUOTA_ERROR.test(message)) throw new ApiError(429, "llm_quota", "the free Workers AI allocation is used up; try again later", 3600);
    throw new ApiError(502, "llm_failed", message);
  }
}
