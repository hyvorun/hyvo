/**
 * A run's hash, computed off the page's thread: a 1,000 agent run takes seconds on a phone, and the replay should not freeze meanwhile.
 * Where a worker cannot start, it is computed here instead, so the check always happens.
 */
import { hashRun, type RunV1 } from "@hyvo/schema";

export function hashInBackground(run: RunV1): Promise<string> {
  return new Promise((done) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./hash-run.worker.ts", import.meta.url), { type: "module" });
    } catch {
      done(hashRun(run));
      return;
    }
    worker.onmessage = (event: MessageEvent<string>) => {
      worker.terminate();
      done(event.data);
    };
    worker.onerror = () => {
      worker.terminate();
      done(hashRun(run));
    };
    worker.postMessage(run);
  });
}
