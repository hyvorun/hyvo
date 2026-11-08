/**
 * Reading a run.json upload. Size and the first bytes are always checked. The zod schema and the
 * hash cost more CPU than the Workers Free plan allows (docs/OPEN_ITEMS.md item 21), so
 * `parseRunBytes` runs only with VERIFY_RUNS_IN_WORKER=1; the runner verifies every run before it
 * uploads, and every browser that opens a run re-hashes it.
 */
import { RunV1, verifyRunHash, type RunV1 as Run } from "@hyvo/schema";
import { ApiError } from "./errors";

export const MAX_RUN_BYTES = 5 * 1024 * 1024;

export function tooLarge(): ApiError {
  return new ApiError(413, "too_large", `run.json must be at most ${MAX_RUN_BYTES} bytes`);
}

/** Read a request body of at most `limit` bytes (the declared length is checked first). */
export async function readRunBody(request: Request, limit: number = MAX_RUN_BYTES): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) throw tooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw tooLarge();
  return bytes;
}

/** The checks that cost nothing: a JSON object, without a byte order mark. */
export function checkRunBytes(bytes: Uint8Array): void {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new ApiError(400, "invalid_run", "run.json must not start with a byte order mark");
  }
  if (bytes[0] !== 0x7b) throw new ApiError(400, "invalid_run", "run.json must be a JSON object");
}

/** A valid, correctly hashed run, or a 400 `invalid_run` that names the problem. */
export function parseRunBytes(bytes: Uint8Array): Run {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_run", "the body is not UTF-8 JSON");
  }
  const parsed = RunV1.safeParse(document);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "run"}: ${issue.message}`);
    throw new ApiError(400, "invalid_run", problems.join("; "));
  }
  const run = parsed.data;
  const check = verifyRunHash(run);
  if (!check.ok) throw new ApiError(400, "invalid_run", `hash ${run.hash} does not match the content (${check.expected})`);
  return run;
}
