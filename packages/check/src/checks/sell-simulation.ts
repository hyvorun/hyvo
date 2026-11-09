// The exit simulation: one read-only eth_call that places the SellCheck probe's code at a throwaway address
// (a state override, with made-up ETH), buys the token through its venue, sends a tenth to a fresh address and
// sells the rest back. Nothing is signed or sent. The finding states what each step promised and delivered.

import { sameAddress, shortenAddress } from "../chain/abi.js";
import { supportsStateOverride } from "../chain/capabilities.js";
import { decodeRevert } from "../chain/revert.js";
import { type JsonRpcClient, RpcError } from "../chain/rpc.js";
import { formatAmount, formatEth, formatPct, shortfallPct } from "../chain/units.js";
import { makeFinding } from "../output/finding.js";
import { decodeProbeResult, encodeProbeCall, PROBE_RUNTIME, type ProbeFunction, type ProbeResult } from "../probe/index.js";
import { ADDRESSES, PROBE_ADDRESS, PROBE_CALLER } from "../registry/addresses.js";
import type { Address, ExitSimulation, Finding, Step, Venue } from "../types.js";
import { CHECKS } from "./catalog.js";

const WETH = ADDRESSES.weth.address;
const PROBE_GAS = "0x1c9c380"; // 30,000,000

/** A step counts as arriving short above this, in percent: rounding in a venue's own math stays below it. */
export const SHORTFALL_TOLERANCE_PCT = 0.01;

function probeCall(token: Address, venue: Venue, ethIn: bigint): { name: ProbeFunction; args: unknown[] } {
  switch (venue.kind) {
    case "v2":
      return { name: "checkV2", args: [venue.router, WETH, token, ethIn] };
    case "pons-curve":
      return { name: "checkPonsCurve", args: [venue.curve, token, ethIn] };
    case "v3":
      return { name: "checkV3", args: [venue.router, venue.quoter, WETH, token, venue.fee, ethIn] };
    case "pons-v4": {
      const quoteFirst = BigInt(venue.quote) < BigInt(token);
      const [c0, c1] = quoteFirst ? [venue.quote, token] : [token, venue.quote];
      return {
        name: "checkV4",
        args: [venue.poolManager, [c0, c1, venue.fee, venue.tickSpacing, venue.hooks], quoteFirst, WETH, ethIn],
      };
    }
  }
}

/** Runs the probe at `block`. Returns its result, or why it could not run. */
export async function runProbe(
  rpc: JsonRpcClient,
  block: string,
  token: Address,
  venue: Venue,
  ethIn: bigint,
): Promise<{ result: ProbeResult } | { error: string }> {
  const { name, args } = probeCall(token, venue, ethIn);
  const data = encodeProbeCall(name, args);
  const balance = `0x${(ethIn + 10n ** 18n).toString(16)}`;
  let raw: string;
  try {
    raw = await rpc.ethCall({ from: PROBE_CALLER, to: PROBE_ADDRESS, data, gas: PROBE_GAS }, block, {
      [PROBE_ADDRESS]: { code: PROBE_RUNTIME, balance },
    });
  } catch (error) {
    if (error instanceof RpcError && error.kind === "revert") return { error: `the probe call reverted: ${decodeRevert(error.data)}` };
    if (error instanceof RpcError && error.kind === "aborted") throw error;
    return { error: `the simulation call failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!raw || raw === "0x") {
    const honored = await supportsStateOverride(rpc, block);
    return {
      error: honored
        ? "the probe returned nothing"
        : "the RPC does not honor state overrides in eth_call, which the simulation needs",
    };
  }
  try {
    return { result: decodeProbeResult(name, raw) };
  } catch {
    return { error: "the probe's answer could not be decoded" };
  }
}

function step(ok: boolean, promised: bigint | null, arrived: bigint, gas: bigint | null, reason: string | null): Step {
  return {
    ok,
    promised,
    arrived,
    shortfallPct: promised !== null && promised > 0n ? shortfallPct(promised, arrived) : null,
    gas,
    reason: ok ? null : reason,
  };
}

export function buildExit(venue: Venue, ethIn: bigint, r: ProbeResult): ExitSimulation {
  const payout =
    venue.kind === "v3" || (venue.kind === "pons-v4" && sameAddress(venue.quote, WETH)) ? "weth" : "eth";
  const buy = step(r.buyOk, r.expectedBuy > 0n ? r.expectedBuy : null, r.gotBuy, r.buyGas, decodeRevert(r.buyErr));
  if (!r.buyOk || r.gotBuy === 0n) return { venue, ethIn, payout, buy, transfer: null, sell: null, roundTrip: null };

  const transfer = step(r.transferOk, r.transferSent, r.transferArrived, null, decodeRevert(r.transferErr));
  const sellReason = r.approveOk ? decodeRevert(r.sellErr) : `approve did not go through, then ${decodeRevert(r.sellErr)}`;
  const sell = step(r.sellOk, r.expectedSell > 0n ? r.expectedSell : null, r.gotSell, r.sellGas, sellReason);
  let roundTrip: ExitSimulation["roundTrip"] = null;
  if (r.sellOk) {
    const spent = (ethIn * r.sellIn) / r.gotBuy;
    roundTrip = { spent, back: r.gotSell, lossPct: spent > 0n ? shortfallPct(spent, r.gotSell) : 0 };
  }
  return { venue, ethIn, payout, buy, transfer, sell, roundTrip };
}

function isShort(s: Step | null): boolean {
  return s !== null && s.shortfallPct !== null && s.shortfallPct > SHORTFALL_TOLERANCE_PCT;
}

function versus(s: Step, what: string): string {
  if (s.shortfallPct === null) return "with no quote to compare";
  if (s.shortfallPct > SHORTFALL_TOLERANCE_PCT) return `${formatPct(s.shortfallPct)} short of ${what}`;
  if (s.shortfallPct < -SHORTFALL_TOLERANCE_PCT) return `${formatPct(-s.shortfallPct)} more than ${what}`;
  return `matching ${what}`;
}

function venueName(v: Venue): string {
  switch (v.kind) {
    case "v2":
      return `the Uniswap V2 pair ${shortenAddress(v.pair)}`;
    case "v3":
      return `the Uniswap V3 pool ${shortenAddress(v.pool)}`;
    case "pons-curve":
      return `the Pons v2 curve ${shortenAddress(v.curve)}`;
    case "pons-v4":
      return `the Pons V4 pool (hook ${shortenAddress(v.hooks)})`;
  }
}

function quoteSource(v: Venue): string {
  switch (v.kind) {
    case "v2":
      return "the router's quote";
    case "v3":
      return "QuoterV2's quote";
    case "pons-curve":
      return "the curve's math after its fee and taxes";
    case "pons-v4":
      return "the pool's swap delta";
  }
}

/** The finding for the simulation; `skip` is why it did not run, when it did not. */
export function sellSimulationFinding(
  exit: ExitSimulation | null,
  decimals: number | null,
  block: bigint,
  skip: string | null,
): Finding {
  const id = "sell-simulation";
  const title = CHECKS[id].title;
  if (!exit) return makeFinding({ id, title, status: "skipped", evidence: skip ?? "the simulation did not run" });

  const dec = decimals ?? 18;
  const q = quoteSource(exit.venue);
  const paid = exit.payout === "weth" ? "WETH" : "ETH";
  const head = `at block ${block.toLocaleString("en-US")} through ${venueName(exit.venue)}`;
  const { buy, transfer, sell, roundTrip } = exit;

  if (!buy.ok) {
    return makeFinding({
      id,
      title,
      status: "skipped",
      evidence: `${head}: the buy of ${formatEth(exit.ethIn)} reverted with ${buy.reason ?? "no reason given"}, so nothing was bought and no sell was tried`,
    });
  }
  const parts = [
    `${head}: the buy of ${formatEth(exit.ethIn)} delivered ${formatAmount(buy.arrived, dec)} tokens, ${versus(buy, q)}`,
  ];
  if (buy.arrived === 0n || !transfer || !sell) {
    parts.push("so nothing was left to send or sell");
    return makeFinding({ id, title, status: "found", evidence: parts.join("; ") });
  }
  parts.push(
    transfer.ok
      ? `sending ${formatAmount(transfer.promised ?? 0n, dec)} to a fresh address delivered ${formatAmount(transfer.arrived, dec)}${
          isShort(transfer) ? ` (${formatPct(transfer.shortfallPct!)} short)` : " (in full)"
        }`
      : `sending a tenth to a fresh address reverted with ${transfer.reason ?? "no reason given"}`,
  );
  parts.push(
    sell.ok
      ? `the sell brought back ${formatAmount(sell.arrived, 18)} ${paid}, ${versus(sell, q)}`
      : `the sell reverted with ${sell.reason ?? "no reason given"}`,
  );
  if (roundTrip) {
    parts.push(
      roundTrip.lossPct >= 0
        ? `the round trip lost ${formatPct(roundTrip.lossPct)} of what the sold part cost`
        : `the round trip returned ${formatPct(-roundTrip.lossPct)} more than the sold part cost at the buy's average price`,
    );
  }

  const found = !transfer.ok || !sell.ok || isShort(buy) || isShort(transfer) || isShort(sell);
  return makeFinding({ id, title, status: found ? "found" : "not_found", evidence: parts.join("; ") });
}
