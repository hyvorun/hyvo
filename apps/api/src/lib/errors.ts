import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error with a machine code, answered as `{ error: { code, message } }` (docs/API.md). */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  retryAfterS?: number,
) {
  if (retryAfterS !== undefined) c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterS))));
  return c.json({ error: { code, message } }, status);
}

/** Parse a JSON body with a zod schema; a 400 `bad_request` names the first problems. */
export async function readJson<T>(
  c: Context,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } },
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, "bad_request", "the body must be JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`);
    throw new ApiError(400, "bad_request", problems.join("; "));
  }
  return parsed.data;
}
