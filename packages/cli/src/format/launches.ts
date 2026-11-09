// How Pons launches read in a terminal. Every number is something a contract holds or an event recorded, in the
// launch's own pair asset; the words for each fact are the web page's. Nothing here rates a launch.

import {
  distinctName,
  formatAmount,
  formatBps,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUtc,
  NATIVE,
  phaseExplained,
  phaseLabel,
  progress,
  shortAddress,
  type Asset,
  type Launch,
  type LaunchDetail,
} from "@hyvo/launches";
import type { Palette } from "../color.js";
import { listedPhase, type LastHour, type OneLaunch, type RecentLaunches } from "../launches.js";
import { checkDisclaimer } from "./check.js";
import { factLines, headingLine, paragraph, tableLines, tableWidth, titleLines, type Fact } from "./facts.js";
import { oneLine, wrap } from "./text.js";

export interface LaunchesRenderOptions {
  palette: Palette;
  /** Terminal width, or null when stdout is not a terminal (nothing is wrapped or shortened). */
  width: number | null;
  /** "Read in … s: … Nothing was signed or sent." */
  readLine: string;
}

export function pairSymbol(asset: Asset): string {
  return oneLine(asset.symbol ?? shortAddress(asset.address), 12);
}

/** "0.0599 ETH", or "not read". */
export function amount(value: bigint | null, asset: Asset): string {
  return value === null ? "not read" : `${formatAmount(value, asset.decimals)} ${pairSymbol(asset)}`;
}

function symbolOf(launch: { symbol: string | null; token: string }): string {
  return launch.symbol ? oneLine(launch.symbol, 14) : shortAddress(launch.token);
}

function age(at: number | null, now: number): string {
  return at === null ? "unknown" : formatDuration(now - at);
}

/**
 * What a listed curve holds, towards its threshold: "0.05994 of 4.2 ETH, 1.4%". `pooled`: the factory's
 * PoolGraduated for the token is among the window's events. graduated() turns true when the curve is swept, before
 * the pool exists, so it alone does not say the launch trades in its pool.
 */
export function curveHolds(launch: Launch, pooled: boolean): string {
  if (pooled) return "moved to its pool";
  if (launch.graduated) return "off its curve, no pool yet";
  if (launch.liquidity === null) return "not read";
  const share = progress(launch.liquidity, launch.graduationThreshold);
  const unit = pairSymbol(launch.pair);
  const of = `${formatAmount(launch.liquidity, launch.pair.decimals)} of ${formatAmount(launch.graduationThreshold, launch.pair.decimals)} ${unit}`;
  return share === null ? of : `${of}, ${formatPercent(share)}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function span(hours: number): string {
  return hours === 1 ? "the last hour" : `the last ${hours} hours`;
}

/**
 * The window's graduations, apart from its launches: a curve that launched before the window can graduate in it,
 * so the count is not a share of the window's launches.
 */
export function graduationsLine(graduations: RecentLaunches["graduations"]): string {
  const here = graduations.filter((event) => event.launchedInWindow).length;
  if (graduations.length === 0) return "No curve graduated to its pool in these blocks.";
  if (graduations.length === 1) return `1 curve graduated to its pool in these blocks (it launched ${here === 1 ? "in" : "before"} the window).`;
  return `${graduations.length} curves graduated to their pools in these blocks (${here} of them launched in the window).`;
}

export function renderRecentLaunches(result: RecentLaunches, o: LaunchesRenderOptions): string {
  const c = o.palette;
  const now = result.read.timestamp || result.head.timestamp;
  const lines = titleLines(
    "HYVO LAUNCHES",
    `Pons V2, ${span(result.hours)}`,
    [`blocks ${result.fromBlock} to ${result.head.block}`, `curves read at block ${result.read.block}`],
    c,
    o.width,
  );
  const count = `${result.total} ${result.total === 1 ? "launch" : "launches"} in ${span(result.hours)}.`;
  const pairs = result.byPair.map((row) => `${row.pair ? pairSymbol(row.pair) : shortAddress(row.address)} ${row.launches}`);
  const summary = pairs.length > 0 ? `${count} Paired with: ${pairs.join(", ")}.` : count;
  lines.push("", ...paragraph(`${summary} ${graduationsLine(result.graduations)}`, o.width), "");

  if (result.launches.length === 0) {
    lines.push(...paragraph(result.total === 0 ? `No Pons launch in ${span(result.hours)}.` : "No launch could be listed: their pair assets' decimals could not be read.", o.width, c.gray));
  } else {
    const head = ["age", "token", "pair", "phase", "on its curve", "creator tax", "address"];
    const pooled = new Set(result.graduations.map((event) => event.token.toLowerCase()));
    const rows = (short: boolean) =>
      result.launches.map((launch) => [
        age(launch.launchedAt, now),
        symbolOf(launch),
        pairSymbol(launch.pair),
        lowerFirst(listedPhase(launch)),
        curveHolds(launch, pooled.has(launch.token.toLowerCase())),
        launch.creatorTaxBps === null ? "not read" : formatBps(launch.creatorTaxBps),
        short ? shortAddress(launch.token) : launch.token,
      ]);
    const full = rows(false);
    const shorten = o.width !== null && tableWidth(head, full) > o.width;
    lines.push(...tableLines(head, shorten ? rows(true) : full, c));
    const notes: string[] = [];
    const rest = result.total - result.launches.length;
    if (rest > 0) notes.push(`${rest} more in the window: hyvo launches --hours ${result.hours} --limit ${Math.min(100, result.total)}`);
    notes.push("One launch's facts: hyvo launches <token>");
    if (shorten) notes.push("Addresses are shortened to fit this terminal; --json has them in full.");
    lines.push("", ...notes.flatMap((note) => paragraph(note, o.width, c.gray)));
  }
  lines.push(
    "",
    ...paragraph(
      "The phase is the curve's own graduated(); what a curve holds is its realQuoteReserve() of the pair asset, towards the threshold it graduates at. Ages run to the block the curves were read at.",
      o.width,
      c.gray,
    ),
  );
  lines.push(...paragraph(o.readLine, o.width, c.gray), ...paragraph(checkDisclaimer(result.read.block), o.width), "");
  return lines.join("\n");
}

function pairFact(pair: Asset): Fact {
  const value =
    pair.address === NATIVE
      ? "ETH, the chain's own currency"
      : `${pairSymbol(pair)}${pair.name && pair.name !== pair.symbol ? ` (${oneLine(pair.name, 40)})` : ""} ${pair.address}`;
  return { label: "pair asset", value, note: "Every buy and sell on its curve, and its pool after graduation, is in this asset." };
}

function detailFacts(detail: LaunchDetail): Fact[] {
  const graduated = detail.phase === "graduated" || detail.graduated === true;
  const now = detail.read.timestamp;
  const share = progress(detail.liquidity, detail.graduationThreshold);
  const facts: Fact[] = [
    { label: "phase", value: phaseLabel(detail.phase, detail.graduated), note: phaseExplained(detail.phase) },
    graduated
      ? { label: "towards graduation", value: "graduated" }
      : {
          label: "towards graduation",
          value: `${share === null ? "not read" : formatPercent(share)}: its curve holds ${amount(detail.liquidity, detail.pair)} of the ${amount(detail.graduationThreshold, detail.pair)} it graduates at`,
        },
    pairFact(detail.pair),
    { label: "creator tax", value: formatBps(detail.creatorTaxBps), note: "Set at launch and fixed: charged on every curve trade on top of the fee, and paid to the creator in full." },
    {
      label: "trading fee",
      value: detail.feeBps === null ? "not read" : formatBps(detail.feeBps),
      note: "Taken from every curve trade and split between Pons, the creator and any buyback.",
    },
    { label: "buyback", value: detail.buybackEnabled ? "on" : "off", note: "When on, a share of the fees buys the token back and locks it." },
  ];
  if (detail.snipeTaxStartBps !== null && detail.snipeTaxSeconds !== null) {
    facts.push({
      label: "launch-second tax",
      value: detail.snipeTaxStartBps === 0 ? "none" : `${formatBps(detail.snipeTaxStartBps)}, gone after ${formatDuration(detail.snipeTaxSeconds)}`,
      note: "A tax on buys in the first seconds after launch, falling to zero. Wallets the creator named at launch are exempt.",
    });
  }
  if (detail.supply !== null) facts.push({ label: "supply", value: formatTokens(detail.supply) });
  if (detail.reserved !== null) {
    facts.push({ label: "kept for the pool", value: formatTokens(detail.reserved), note: "The curve never sells below this; it seeds the Uniswap V4 pool at graduation." });
  }
  if (!graduated && detail.sellable !== null) facts.push({ label: "left to buy", value: `${formatTokens(detail.sellable)}, on the curve` });
  facts.push({
    label: "launched",
    value: detail.launchedAt ? `${formatUtc(detail.launchedAt)}, ${formatDuration(now - detail.launchedAt)} before this block` : "not read",
  });
  facts.push({ label: "creator", value: detail.creator, note: "The address Pons records as the launch's deployer." });
  if (detail.feeRecipient.toLowerCase() !== detail.creator.toLowerCase()) facts.push({ label: "creator fees go to", value: detail.feeRecipient });
  facts.push({ label: "bonding curve", value: detail.curve });
  return facts;
}

function lastHourLines(lastHour: LastHour, detail: LaunchDetail, c: Palette, width: number | null): string[] {
  if (lastHour === null) return [];
  if (lastHour.status === "failed") {
    return ["", headingLine("The last hour on its curve", null, c), ...paragraph(`Its trades could not be read just now: ${lastHour.message}`, width, c.gray)];
  }
  const lines = ["", headingLine("The last hour on its curve", `blocks ${lastHour.fromBlock} to ${lastHour.toBlock}, from its CurveBuy and CurveSell events`, c)];
  const a = lastHour.activity;
  if (!a) {
    lines.push(...paragraph(detail.phase === "graduated" ? "Its curve no longer trades: it graduated." : "No trade on its curve in this hour.", width, c.gray));
    return lines;
  }
  const facts: Fact[] = [
    { label: "trades", value: `${a.trades}: ${a.buys} ${a.buys === 1 ? "buy" : "buys"} and ${a.sells} ${a.sells === 1 ? "sell" : "sells"}` },
    { label: "traders", value: String(a.traders), note: "Different addresses that received the tokens or the pair asset." },
    { label: "traded", value: `${amount(a.volume, detail.pair)}, before fee and tax` },
  ];
  if (a.tax > 0n) facts.push({ label: "creator tax paid", value: amount(a.tax, detail.pair) });
  lines.push(...factLines(facts, c, width));
  return lines;
}

export function renderOneLaunch(result: OneLaunch, o: LaunchesRenderOptions): string {
  const c = o.palette;
  const { lookup } = result;
  const lines: string[] = [];
  if (lookup.kind === "v2") {
    const d = lookup.detail;
    const name = distinctName(d.name, d.symbol);
    const subject = `${symbolOf(d)}${name ? ` (${oneLine(name, 40)})` : ""}`;
    lines.push(...titleLines("HYVO LAUNCHES", subject, ["Pons V2 launch", d.token, `block ${d.read.block}`], c, o.width), "");
    lines.push(...factLines(detailFacts(d), c, o.width));
    lines.push(...lastHourLines(result.lastHour, d, c, o.width));
    lines.push("", ...paragraph(`Its facts as a token, and an exit simulation: hyvo check ${d.token}`, o.width, c.gray));
  } else if (lookup.kind === "v1") {
    const name = distinctName(lookup.name, lookup.symbol);
    const subject = `${symbolOf({ symbol: lookup.symbol, token: lookup.token })}${name ? ` (${oneLine(name, 40)})` : ""}`;
    lines.push(...titleLines("HYVO LAUNCHES", subject, ["Pons V1 launch", lookup.token, `block ${lookup.read.block}`], c, o.width), "");
    const paired = lookup.paired ? pairSymbol(lookup.paired) : "its pair asset";
    lines.push(
      ...paragraph(
        `This token launched through Pons V1, which has no bonding curve: each token starts in a Uniswap V3 pool against ${paired}, at a ${formatBps(lookup.poolFee / 100)} fee. Hyvo Launches reads the facts of Pons V2 launches.`,
        o.width,
      ),
      "",
      ...factLines(
        [
          { label: "token", value: lookup.token },
          { label: "creator", value: lookup.creator },
          { label: "supply", value: formatTokens(lookup.supply) },
        ],
        c,
        o.width,
      ),
      "",
      ...paragraph(`Its facts as a token, and an exit simulation: hyvo check ${lookup.token}`, o.width, c.gray),
    );
  } else {
    const subject = lookup.symbol ? oneLine(lookup.symbol, 14) : "";
    lines.push(...titleLines("HYVO LAUNCHES", subject, [result.token, `block ${lookup.read.block}`], c, o.width), "");
    lines.push(
      ...paragraph(
        `No Pons V2 launch at this address. The Pons V2 launch factory has no record of ${result.token}, and neither does the current Pons V1 factory. It may be a token from somewhere else, or not a token at all.`,
        o.width,
      ),
      "",
      ...paragraph(`Its facts as a token, if it is one: hyvo check ${result.token}`, o.width, c.gray),
    );
  }
  const block = lookup.kind === "v2" ? lookup.detail.read.block : lookup.read.block;
  lines.push("", ...wrap(o.readLine, o.width, "  ").map((line) => c.gray(line)), ...paragraph(checkDisclaimer(block), o.width), "");
  return lines.join("\n");
}
