import { readFileSync } from "node:fs";
import { createPublicClient, custom, type PublicClient } from "viem";
import { parseFeedDirectory, type FeedListing } from "../src/feeds";

interface Recording {
  recordedAt: string;
  calls: { method: string; params: unknown; result: unknown }[];
}

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

/** A client that answers from a recording of the live RPC (scripts/record.ts), and nothing else. */
export function replayClient(name: string): PublicClient {
  const recording = fixture<Recording>(name);
  const answers = new Map(recording.calls.map((call) => [`${call.method} ${JSON.stringify(call.params)}`, call.result]));
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const key = `${method} ${JSON.stringify(params ?? [])}`;
        if (!answers.has(key)) throw new Error(`not in the recording: ${key.slice(0, 160)}`);
        return answers.get(key);
      },
    }),
  }) as PublicClient;
}

export function recordedDirectory(): { listings: FeedListing[]; fetchedAt: string } {
  const body = fixture<{ fetchedAt: string; entries: unknown[] }>("feed-directory.subset.json");
  return { listings: parseFeedDirectory(body.entries), fetchedAt: body.fetchedAt };
}

export function recordedAt(name: string): string {
  return fixture<Recording>(name).recordedAt;
}
