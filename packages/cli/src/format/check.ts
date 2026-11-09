// How a Hyvo Check report reads in a terminal, and its JSON. The text states what each check found, with its
// evidence, in the order the report lists them. It never sums them up into a verdict.

import {
  formatAmount,
  formatPct,
  ROBINHOOD_CHAIN,
  serializeReport,
  shortenAddress,
  SHORTFALL_TOLERANCE_PCT,
  type CheckReport,
  type ExitSimulation,
  type Finding,
  type FindingStatus,
  type JsonCheckReport,
  type Step,
  type Venue,
} from "@hyvo/check";
import { visibleLength, type Palette } from "../color.js";
import { hostOf } from "../config.js";
import { joinFit, MAX_WIDTH, oneLine, padEnd, spread, wrap } from "./text.js";

/** The line every check result carries. */
export function checkDisclaimer(block: bigint): string {
  return `Measured on-chain at block ${block}. Not a trading signal.`;
}

/** `hyvo check --json`: the report as @hyvo/check serializes it (bigints as decimal strings), and the line above. */
export type CheckJson = JsonCheckReport & { disclaimer: string };

export function checkJson(report: CheckReport): CheckJson {
  return { ...serializeReport(report), disclaimer: checkDisclaimer(report.block) };
}

export const STATUS_LABEL: Record<FindingStatus, string> = { found: "found", not_found: "not found", skipped: "skipped" };

const STATUS_WIDTH = 11;
const EVIDENCE_INDENT = " ".repeat(2 + STATUS_WIDTH);

export interface CheckRenderOptions {
  palette: Palette;
  /** Terminal width, or null to keep each evidence on one line. */
  width: number | null;
  /** The JSON-RPC endpoint the check read from, for the requests line. */
  rpcUrl: string;
}

export function tokenLabel(report: Pick<CheckReport, "token">): string {
  const { name, symbol } = report.token;
  const shownName = name ? oneLine(name, 40) : "Unnamed token";
  return symbol ? `${shownName} (${oneLine(symbol, 16)})` : shownName;
}

export function renderCheck(report: CheckReport, options: CheckRenderOptions): string {
  const c = options.palette;
  const inner = Math.min(options.width ?? 100, MAX_WIDTH) - 2;
  const left = `${c.bold("HYVO CHECK")}   ${tokenLabel(report)}`;
  const chain = `${ROBINHOOD_CHAIN.name} · ${report.chainId}`;
  const fits = visibleLength(left) + 3 + chain.length <= inner;
  const where = [report.token.address, `block ${report.block}`, ...(fits ? [] : [chain])];
  const lines = ["", `  ${fits ? spread(left, c.gray(chain), inner) : left}`, ...joinFit(where, options.width, "  ").map((line) => c.gray(line)), ""];
  for (const finding of report.findings) lines.push(...renderFinding(finding, c, options.width));
  if (report.exit) lines.push("", ...renderExit(report.exit, report.token.decimals, report.token.symbol, c, options.width));
  lines.push("", ...wrap(requestsLine(report, options.rpcUrl), options.width, "  ").map((line) => c.gray(line)), ...wrap(checkDisclaimer(report.block), options.width, "  "), "");
  return lines.join("\n");
}

function statusText(status: FindingStatus, c: Palette): string {
  const label = STATUS_LABEL[status];
  return status === "found" ? c.bold(label) : c.gray(label);
}

export function renderFinding(finding: Finding, c: Palette, width: number | null): string[] {
  const found = finding.status === "found";
  const head = `  ${padEnd(statusText(finding.status, c), STATUS_WIDTH)}${found ? c.bold(finding.title) : finding.title}`;
  const evidence = wrap(finding.evidence, width, EVIDENCE_INDENT).map((line) => (found ? line : c.gray(line)));
  return [head, ...evidence];
}

export function venueLabel(venue: Venue): string {
  switch (venue.kind) {
    case "v2":
      return `Uniswap V2 pair ${shortenAddress(venue.pair)}`;
    case "v3":
      return `Uniswap V3 pool ${shortenAddress(venue.pool)} (fee ${venue.fee / 10_000}%)`;
    case "pons-curve":
      return `Pons v2 curve ${shortenAddress(venue.curve)}`;
    case "pons-v4":
      return `Pons V4 pool (hook ${shortenAddress(venue.hooks)})`;
  }
}

const STEP_WIDTH = 12;
const SHORT_WIDTH = 9;
const STEP_INDENT = " ".repeat(2 + STEP_WIDTH);

/** Text after a step's name, wrapped under itself. */
function hanging(name: string, text: string, width: number | null): string[] {
  const lines = wrap(text, width, STEP_INDENT);
  lines[0] = `  ${padEnd(name, STEP_WIDTH)}${lines[0]!.slice(STEP_INDENT.length)}`;
  return lines;
}

export function renderExit(exit: ExitSimulation, decimals: number | null, symbol: string | null, c: Palette, width: number | null = null): string[] {
  const unit = symbol ? oneLine(symbol, 12) : "tokens";
  const tokens = (value: bigint) => `${formatAmount(value, decimals ?? 18)} ${unit}`;
  const paid = exit.payout === "weth" ? "WETH" : "ETH";
  const eth = (value: bigint) => `${formatAmount(value, 18)} ${paid}`;

  const rows: { name: string; step: Step | null; amount: (value: bigint) => string }[] = [
    { name: "buy", step: exit.buy, amount: tokens },
    { name: "transfer", step: exit.transfer, amount: tokens },
    { name: "sell", step: exit.sell, amount: eth },
  ];
  // Columns as wide as their longest amount, so the table stays narrow.
  const amounts = rows.flatMap(({ step, amount }) => (step?.ok ? [step.promised === null ? "no quote" : amount(step.promised), amount(step.arrived)] : []));
  const amountWidth = Math.max("promised".length, ...amounts.map((a) => a.length)) + 3;

  const lines = [
    ...joinFit([`${c.bold("Exit simulation")}   ${venueLabel(exit.venue)}`, `${formatAmount(exit.ethIn, 18)} ETH in`, "inside one eth_call"], width, "  "),
    `  ${c.gray(padEnd("step", STEP_WIDTH) + padEnd("promised", amountWidth) + padEnd("arrived", amountWidth) + padEnd("short", SHORT_WIDTH) + "gas")}`,
  ];
  const nothing = exit.buy.ok ? "not tried: the buy delivered no tokens" : "not tried: the buy reverted";
  for (const { name, step, amount } of rows) {
    if (!step) {
      lines.push(`  ${padEnd(name, STEP_WIDTH)}${c.gray(nothing)}`);
    } else if (!step.ok) {
      lines.push(...hanging(name, c.bold(`reverted: ${step.reason ? oneLine(step.reason, 96) : "no reason given"}`), width));
    } else {
      const promised = step.promised === null ? c.gray("no quote") : amount(step.promised);
      const short = step.shortfallPct === null ? c.gray("n/a") : formatPct(step.shortfallPct);
      const shortShown = step.shortfallPct !== null && step.shortfallPct > SHORTFALL_TOLERANCE_PCT ? c.bold(short) : short;
      const gas = step.gas === null ? "" : step.gas.toLocaleString("en-US");
      lines.push(`  ${padEnd(name, STEP_WIDTH)}${padEnd(promised, amountWidth)}${padEnd(amount(step.arrived), amountWidth)}${padEnd(shortShown, SHORT_WIDTH)}${gas}`.trimEnd());
    }
  }
  const trip = exit.roundTrip;
  if (trip) {
    const result = trip.lossPct >= 0 ? `${formatPct(trip.lossPct)} lost` : `${formatPct(-trip.lossPct)} more came back`;
    lines.push(...hanging("round trip", `${result}: the part sold cost ${eth(trip.spent)} at the buy's average price, and ${eth(trip.back)} came back`, width));
  }
  return lines;
}

/** Where the check sent requests, so nothing about the network is hidden. */
export function requestsLine(report: Pick<CheckReport, "timings">, rpcUrl: string): string {
  const { requests, totalMs } = report.timings;
  const parts = [`${requests.rpc} ${requests.rpc === 1 ? "request" : "requests"} to ${hostOf(rpcUrl)}`];
  if (requests.sourcify > 0) parts.push(`${requests.sourcify} to ${hostOf(ROBINHOOD_CHAIN.sourcifyUrl)}`);
  if (requests.blockscout > 0) parts.push(`${requests.blockscout} to ${hostOf(ROBINHOOD_CHAIN.blockscoutApiUrl)}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Read in ${(totalMs / 1000).toFixed(1)} s: ${list}. Nothing was signed or sent.`;
}
