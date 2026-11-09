/**
 * Prints the report for tickers or addresses as JSON, read live: what a CLI command would show.
 *
 * Usage: pnpm --filter @hyvo/stocks report NVDA 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { fetchFeedDirectory } from "../src/feeds";
import { parseQuery } from "../src/query";
import { stockReport } from "../src/report";
import { snapshotByTicker } from "../src/snapshot";
import { DEFAULT_RPC } from "./rpc";

const client = createPublicClient({ transport: http(process.env.RH_RPC_URL || DEFAULT_RPC, { retryCount: 3 }) }) as PublicClient;

for (const input of process.argv.slice(2)) {
  const query = parseQuery(input);
  if (query.kind === "invalid" || query.kind === "empty") {
    console.error(`${input}: ${query.kind === "invalid" ? query.reason : "nothing to look up"}`);
    continue;
  }
  const addresses = query.kind === "address" ? [query.address] : snapshotByTicker(query.ticker).map((token) => token.address);
  if (addresses.length === 0) console.error(`${input}: no stock token in Hyvo's list has this ticker`);
  for (const address of addresses) {
    const report = await stockReport(client, address, { directory: fetchFeedDirectory });
    console.log(JSON.stringify({ input, ...report, listed: report.listed ? { ...report.listed, multiplierUpdates: report.listed.multiplierUpdates.length } : null }, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  }
}
