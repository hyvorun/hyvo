// Runs Hyvo Check on real tokens against Robinhood Chain and prints each report. Read-only: JSON-RPC reads and
// eth_call only, plus Sourcify (and Blockscout when HYVO_BLOCKSCOUT_KEY is set).
//
// Usage, from packages/check:
//   pnpm check <address> [<address> ...] [--eth-in 0.001] [--rpc <url>] [--json]
import { CHECKS, checkToken, formatEth, parseEth, serializeReport } from "../src/index";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes("--json");
const ethIn = flag("--eth-in") ? parseEth(flag("--eth-in")!) : undefined;
const rpc = flag("--rpc");
const tokens = args.filter((a, i) => /^0x[0-9a-fA-F]{40}$/.test(a) && args[i - 1] !== "--rpc");
if (tokens.length === 0) {
  console.error("usage: pnpm check <address> [<address> ...] [--eth-in 0.001] [--rpc <url>] [--json]");
  process.exit(64);
}

for (const token of tokens) {
  try {
    const report = await checkToken(token, {
      ethIn,
      rpcUrls: rpc ? [rpc] : undefined,
      blockscoutKey: process.env.HYVO_BLOCKSCOUT_KEY || undefined,
    });
    if (json) {
      console.log(JSON.stringify(serializeReport(report), null, 2));
      continue;
    }
    const t = report.token;
    console.log(`\n${t.name ?? "?"} (${t.symbol ?? "?"}) ${t.address} at block ${report.block}`);
    for (const f of report.findings) {
      console.log(`  ${CHECKS[f.id].title.padEnd(24)} ${f.status.padEnd(9)} ${f.evidence}`);
    }
    const x = report.exit;
    if (x) {
      const pct = (v: number | null) => (v === null ? "n/a" : `${v}%`);
      console.log(
        `  exit: ${x.venue.kind}, ${formatEth(x.ethIn)} in; buy short ${pct(x.buy.shortfallPct)}, transfer short ${pct(
          x.transfer?.shortfallPct ?? null,
        )}, sell ${x.sell?.ok ? `short ${pct(x.sell.shortfallPct)}` : `reverted: ${x.sell?.reason ?? "-"}`}, round trip ${pct(
          x.roundTrip?.lossPct ?? null,
        )}`,
      );
    }
    const r = report.timings.requests;
    console.log(
      `  ${report.timings.totalMs} ms (chain ${report.timings.chainMs}, simulation ${report.timings.simulationMs ?? "-"}, sources ${report.timings.sourcesMs}); requests: ${r.rpc} rpc, ${r.sourcify} sourcify, ${r.blockscout} blockscout`,
    );
    console.log(`  ${report.notice}`);
  } catch (error) {
    console.log(`\n${token}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}
