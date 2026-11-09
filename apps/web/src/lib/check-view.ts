/**
 * What the /check page shows of a Hyvo Check report, worked out apart from React so it can be
 * tested: the three steps of the exit simulation, the round trip, the venue, and the findings. Every
 * figure comes from the report (packages/check); nothing here judges a token. Amounts stay bigint
 * until they become text.
 */
import {
  CHECKS,
  SHORTFALL_TOLERANCE_PCT,
  CheckError,
  formatAmount,
  formatPct,
  isAddress,
  toChecksumAddress,
  type Address,
  type CheckReport,
  type ExitSimulation,
  type Finding,
  type FindingStatus,
  type Step,
  type TokenInfo,
  type Venue,
} from "@hyvo/check";

/** The first token address in what someone typed or pasted (an address, or a link that holds one), checksummed. */
export function parseAddressInput(text: string): Address | null {
  const trimmed = text.trim().replace(/^0X/, "0x");
  if (isAddress(trimmed)) return toChecksumAddress(trimmed);
  // A link to an explorer or to this page. Exactly 40 hex characters: a transaction hash is not an address.
  const match = /(?:^|[^0-9a-fA-Fx])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/.exec(trimmed);
  return match?.[1] ? toChecksumAddress(match[1]) : null;
}

/** "the evidence" -> "The evidence." Leaves a leading function name or address as it is. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  const capped = /^[a-z]+(?=[\s,:;]|$)/.test(trimmed) ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
  return /[.…?!]$/.test(capped) ? capped : `${capped}.`;
}

/** What a token calls itself, for headings: its symbol, else its name, else nothing. */
export function tokenLabel(token: TokenInfo): string | null {
  return token.symbol || token.name || null;
}

/** Thousands-separated block number. */
export function formatBlock(block: bigint): string {
  return block.toLocaleString("en-US");
}

/** A token amount with its unit: "110,521.42 KSTX", or "110,521.42 tokens" when the token has no symbol. */
export function tokenAmount(value: bigint, token: TokenInfo): string {
  return `${formatAmount(value, token.decimals ?? 18)} ${token.symbol || "tokens"}`;
}

export function ethAmount(wei: bigint, unit: "ETH" | "WETH" = "ETH"): string {
  return `${formatAmount(wei, 18)} ${unit}`;
}

// --- one step ------------------------------------------------------------------------------------

/** lost: less arrived than promised. more: more arrived. even: within rounding. */
export type Tone = "lost" | "more" | "even";

export interface Difference {
  /** Signed, as the arrival differs from the promise: "−5%", "+0.2%", "0%". */
  text: string;
  /** In words: "5% less than promised". */
  note: string;
  tone: Tone;
}

const MINUS = "−";

/**
 * The difference between what arrived and what was promised (or sent), from the report's shortfall:
 * positive when less arrived. Within SHORTFALL_TOLERANCE_PCT it is rounding in the venue's own math.
 */
export function difference(shortfallPct: number, versus: "promised" | "sent"): Difference {
  const size = formatPct(Math.abs(shortfallPct));
  if (shortfallPct === 0 || size === "0%") return { text: "0%", note: versus === "sent" ? "in full" : "as promised", tone: "even" };
  const sign = shortfallPct > 0 ? MINUS : "+";
  if (Math.abs(shortfallPct) <= SHORTFALL_TOLERANCE_PCT) return { text: `${sign}${size}`, note: "within rounding", tone: "even" };
  return shortfallPct > 0
    ? { text: `${sign}${size}`, note: `${size} less than ${versus}`, tone: "lost" }
    : { text: `${sign}${size}`, note: `${size} more than ${versus}`, tone: "more" };
}

/** How much of the promise arrived, as shares of 1 for a bar. The arrived part is capped at the whole. */
export function shares(promised: bigint, arrived: bigint): { arrived: number; lost: number } | null {
  if (promised <= 0n) return null;
  const capped = arrived >= promised ? promised : arrived < 0n ? 0n : arrived;
  const part = Number((capped * 10_000n) / promised) / 10_000;
  return { arrived: part, lost: Math.round((1 - part) * 10_000) / 10_000 };
}

export type StepKey = "buy" | "transfer" | "sell";

export interface StepView {
  key: StepKey;
  number: 1 | 2 | 3;
  title: string;
  /** What the step does, in a few words. */
  line: string;
  state: "done" | "reverted" | "not_tried";
  /** "Promised" for a trade, "Sent" for the transfer. */
  promisedLabel: string;
  /** Null when the venue gave no quote, or the step was not tried. */
  promised: string | null;
  arrived: string | null;
  /** Only for a step that went through and had something to compare with. */
  difference: Difference | null;
  bar: { arrived: number; lost: number } | null;
  /** The revert reason, quoted from the chain; or why the step was not tried. */
  reason: string | null;
  gas: string | null;
}

function stepView(
  key: StepKey,
  step: Step | null,
  amount: (value: bigint) => string,
  notTried: string,
): StepView {
  const base = {
    key,
    number: key === "buy" ? 1 : key === "transfer" ? 2 : 3,
    title: key === "buy" ? "Buy" : key === "transfer" ? "Send to another wallet" : "Sell back",
    line: "",
    promisedLabel: key === "transfer" ? "Sent" : "Promised",
  } as const;
  if (!step) {
    return { ...base, state: "not_tried", promised: null, arrived: null, difference: null, bar: null, reason: notTried, gas: null };
  }
  const promised = step.promised !== null ? amount(step.promised) : null;
  const gas = step.gas !== null ? step.gas.toLocaleString("en-US") : null;
  if (!step.ok) {
    return { ...base, state: "reverted", promised, arrived: amount(0n), difference: null, bar: null, reason: step.reason ?? "no reason given", gas };
  }
  return {
    ...base,
    state: "done",
    promised,
    arrived: amount(step.arrived),
    difference: step.shortfallPct !== null ? difference(step.shortfallPct, key === "transfer" ? "sent" : "promised") : null,
    bar: step.promised !== null ? shares(step.promised, step.arrived) : null,
    reason: null,
    gas,
  };
}

/** The three steps, in order, each with what was promised, what arrived and the difference. */
export function exitSteps(exit: ExitSimulation, token: TokenInfo): StepView[] {
  const tokens = (value: bigint) => tokenAmount(value, token);
  const payout = exit.payout === "weth" ? "WETH" : "ETH";
  const nothing = exit.buy.ok ? "Not tried: the buy delivered nothing to send or sell." : "Not tried: the buy reverted, so there was nothing to send or sell.";
  return [
    { ...stepView("buy", exit.buy, tokens, nothing), line: `${ethAmount(exit.ethIn)} in` },
    { ...stepView("transfer", exit.transfer, tokens, nothing), line: "A tenth of what arrived, to a fresh address" },
    { ...stepView("sell", exit.sell, (wei) => ethAmount(wei, payout), nothing), line: `The rest, back to ${payout}` },
  ];
}

export interface RoundTripView {
  /** cost: less came back than the sold part cost. gain: more came back. none: no round trip. */
  kind: "cost" | "gain" | "none";
  /** The cost (or gain) in percent, unsigned; null without a round trip. */
  percent: string | null;
  line: string;
  bar: { arrived: number; lost: number } | null;
}

/** What buying and selling straight back cost, fees and taxes together, for the part that was sold. */
export function roundTripView(exit: ExitSimulation): RoundTripView {
  const trip = exit.roundTrip;
  const payout = exit.payout === "weth" ? "WETH" : "ETH";
  if (!trip) {
    const why = !exit.buy.ok
      ? "the buy did not go through"
      : !exit.sell
        ? "the buy delivered nothing to sell"
        : "the sell did not go through";
    return { kind: "none", percent: null, line: `No round trip: ${why}.`, bar: null };
  }
  const costs = `The part that was sold cost ${ethAmount(trip.spent)} at the buy's average price, and ${ethAmount(trip.back, payout)} came back`;
  if (trip.lossPct >= 0) {
    return { kind: "cost", percent: formatPct(trip.lossPct), line: `${costs}.`, bar: shares(trip.spent, trip.back) };
  }
  return {
    kind: "gain",
    percent: formatPct(-trip.lossPct),
    line: `${costs}: more than it cost, because the buy itself moved the price of a shallow pool.`,
    bar: shares(trip.spent, trip.back),
  };
}

// --- the venue -----------------------------------------------------------------------------------

export interface VenueView {
  name: string;
  /** The contract to link: the pair, the pool, the curve, or the Pons hook. */
  address: Address;
  addressLabel: string;
  facts: { label: string; value: string }[];
  /** Where each trade's promise comes from, as a phrase: "the router's quote before each trade". */
  promises: string;
}

function basisPoints(bps: number | null): string {
  return bps === null ? "unknown" : formatPct(bps / 100);
}

/** A Uniswap fee in hundredths of a basis point; V4's dynamic-fee flag means the hook sets it. */
function poolFee(fee: number): string {
  return fee & 0x800000 ? "set by the hook" : formatPct(fee / 10_000);
}

export function venueView(venue: Venue): VenueView {
  switch (venue.kind) {
    case "v2":
      return {
        name: "Uniswap V2 pair with WETH",
        address: venue.pair,
        addressLabel: "Pair",
        facts: [],
        promises: "the router's quote before each trade",
      };
    case "v3":
      return {
        name: "Uniswap V3 pool with WETH",
        address: venue.pool,
        addressLabel: "Pool",
        facts: [{ label: "Fee tier", value: poolFee(venue.fee) }],
        promises: "QuoterV2's quote before each trade",
      };
    case "pons-curve":
      return {
        name: "Pons v2 bonding curve",
        address: venue.curve,
        addressLabel: "Curve",
        facts: [
          { label: "Curve fee", value: basisPoints(venue.curveFeeBps) },
          { label: "Creator tax", value: basisPoints(venue.creatorTaxBps) },
          { label: "Snipe tax at this block", value: basisPoints(venue.snipeTaxBpsNow) },
        ],
        promises: "the curve's own math after its fee and taxes",
      };
    case "pons-v4":
      return {
        name: "Uniswap V4 pool with the Pons hook",
        address: venue.hooks,
        addressLabel: "Hook",
        facts: [
          { label: "Pool fee", value: poolFee(venue.fee) },
          { label: "Creator tax", value: basisPoints(venue.creatorTaxBps) },
          { label: "Tick spacing", value: String(venue.tickSpacing) },
          { label: "Quoted in", value: /^0x0{40}$/.test(venue.quote) ? "ETH" : "WETH" },
        ],
        promises: "the pool's swap delta inside each trade",
      };
  }
}

// --- the simulation as a whole -------------------------------------------------------------------

export type ExitState =
  | { kind: "simulated"; exit: ExitSimulation }
  /** No pool or launch with liquidity was found. */
  | { kind: "no_venue"; reason: string; venueEvidence: string }
  /** A venue exists, of a kind the simulation does not trade through yet. */
  | { kind: "not_covered"; reason: string; venueEvidence: string }
  /** The simulation was tried and could not run (the RPC, the probe). */
  | { kind: "failed"; reason: string; venueEvidence: string };

function finding(report: CheckReport, id: Finding["id"]): Finding | undefined {
  return report.findings.find((item) => item.id === id);
}

export function exitState(report: CheckReport): ExitState {
  if (report.exit) return { kind: "simulated", exit: report.exit };
  const reason = finding(report, "sell-simulation")?.evidence ?? "the simulation did not run";
  const venue = finding(report, "venue");
  const venueEvidence = venue?.evidence ?? "";
  if (report.timings.simulationMs !== null) return { kind: "failed", reason, venueEvidence };
  if (venue?.status === "found") return { kind: "not_covered", reason, venueEvidence };
  return { kind: "no_venue", reason, venueEvidence };
}

// --- findings ------------------------------------------------------------------------------------

export const STATUS_LABEL: Record<FindingStatus, string> = { found: "Found", not_found: "Not found", skipped: "Skipped" };

/** "11 checks: 3 found, 6 not found, 2 skipped". */
export function findingSummary(findings: readonly Finding[]): string {
  const count = (status: FindingStatus) => findings.filter((item) => item.status === status).length;
  const parts = (["found", "not_found", "skipped"] as const).map((status) => `${count(status)} ${STATUS_LABEL[status].toLowerCase()}`);
  return `${findings.length} ${findings.length === 1 ? "check" : "checks"}: ${parts.join(", ")}`;
}

/** What a finding's check looks for, so "found" and "not found" read as facts. */
export function looksFor(item: Finding): string {
  return CHECKS[item.id]?.looksFor ?? "";
}

// --- errors --------------------------------------------------------------------------------------

export interface CheckFailure {
  title: string;
  detail: string;
  /** Worth trying again: the chain may answer the next time. */
  retry: boolean;
}

/** Why no report could be made, in words for the page. */
export function checkFailure(error: unknown): CheckFailure {
  if (error instanceof CheckError) {
    switch (error.code) {
      case "invalid_address":
        return { title: "That is not a token address", detail: "A token address is 0x followed by 40 hexadecimal characters.", retry: false };
      case "not_a_contract":
        return {
          title: "No contract at this address",
          detail: "Robinhood Chain holds no code at this address. It may be a wallet, or a contract on another chain.",
          retry: false,
        };
      case "not_a_token":
        return {
          title: "Not a token",
          detail: "The contract at this address answers neither totalSupply() nor balanceOf(address), so it is not an ERC-20 token.",
          retry: false,
        };
      case "wrong_chain":
        return { title: "The wrong chain answered", detail: `${sentence(error.message)} Nothing was checked.`, retry: true };
      case "rpc":
        return {
          title: "Robinhood Chain could not be read just now",
          detail: "Its public endpoints are sometimes busy. Nothing was checked; try again in a moment.",
          retry: true,
        };
      case "aborted":
        return { title: "The check was stopped", detail: "It stopped before it finished.", retry: true };
    }
  }
  return {
    title: "The check could not finish",
    detail: error instanceof Error && error.message ? sentence(error.message) : "Something went wrong while reading the chain.",
    retry: true,
  };
}
