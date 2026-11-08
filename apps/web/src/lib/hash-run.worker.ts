/** Hashes a run away from the page. See hash-run.ts. */
import { hashRun, type RunV1 } from "@hyvo/schema";

self.onmessage = (event: MessageEvent<RunV1>) => {
  self.postMessage(hashRun(event.data));
};
