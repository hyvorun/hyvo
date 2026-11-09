/**
 * Records the live JSON-RPC answers behind a few stock reports into test/fixtures, so the tests
 * replay real chain data without a network. Read-only.
 *
 * Usage: pnpm --filter @hyvo/stocks record
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, custom, type Address, type PublicClient } from "viem";
import { FEED_DIRECTORY_URL, parseFeedDirectory } from "../src/feeds";
import { stockReport } from "../src/report";
import { SNAPSHOT } from "../src/snapshot";
import { rpcClient } from "./rpc";

const rpc = rpcClient();

export interface Recording {
  recordedAt: string;
  rpc: string;
  calls: { method: string; params: unknown; result: unknown }[];
}

function recordingClient(recording: Recording): PublicClient {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const result = await rpc.request<unknown>(method, (params as unknown[]) ?? []);
        recording.calls.push({ method, params: params ?? [], result });
        return result;
      },
    }),
  }) as PublicClient;
}

const out = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

// The directory, cut down to the Robinhood entries the tests need, as fetched.
const directoryBody = (await (await fetch(FEED_DIRECTORY_URL)).json()) as Record<string, unknown>[];
const keep = new Set(["NVDA", "AAPL", "TSLA", "DELL", "SGOV"]);
const subset = directoryBody.filter((entry) => {
  const name = String(entry.name ?? "");
  return [...keep].some((ticker) => name.includes(` ${ticker} `) || name.includes(` ${ticker}-`) || name.endsWith(` ${ticker}`)) || name.startsWith("Robinhood NVDA");
});
writeFileSync(out("feed-directory.subset.json"), `${JSON.stringify({ fetchedAt: new Date().toISOString(), source: FEED_DIRECTORY_URL, entries: subset }, null, 1)}\n`);
const listings = parseFeedDirectory(subset);

const nvda = SNAPSHOT.tokens.find((token) => token.symbol === "NVDA")!;
const cases: [string, Address][] = [
  ["nvda", nvda.address],
  // The StockFactory: a contract that is not a stock token.
  ["factory", SNAPSHOT.factory],
  // An address with no code.
  ["empty", "0x000000000000000000000000000000000000dEaD"],
];
for (const [name, address] of cases) {
  const recording: Recording = { recordedAt: new Date().toISOString(), rpc: "https://robinhood.drpc.org", calls: [] };
  const report = await stockReport(recordingClient(recording), address, { directory: async () => ({ listings, fetchedAt: recording.recordedAt }) });
  writeFileSync(out(`rpc-${name}.json`), `${JSON.stringify(recording, (_, value) => (typeof value === "bigint" ? value.toString() : value), 1)}\n`);
  console.log(name, report.verdict.kind, report.reading.blockNumber, report.feed?.kind ?? "-", `${recording.calls.length} calls`);
}
