import type { Context } from "hono";

const detached = new Set<Promise<unknown>>();

/** Run `work` after the response (`waitUntil`); its errors are logged, never thrown. */
export function inBackground(c: Context, work: Promise<unknown>): void {
  const safe = work.catch((error: unknown) => {
    console.error(JSON.stringify({ level: "error", event: "background_failed", error: String(error).slice(0, 300) }));
  });
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No execution context (unit tests): the promise still runs to completion.
    detached.add(safe);
    void safe.finally(() => detached.delete(safe));
  }
}

/** Tests only: wait for work started without an execution context. */
export async function backgroundDone(): Promise<void> {
  await Promise.all(detached);
}
