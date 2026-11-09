// How Robinhood's stock tokens read in a terminal, with the words of the web pages: whether the StockFactory records
// a contract, its multiplier, what its Chainlink price means and whether it can move right now. A price here is a
// reading of a feed at one block, not a quote to trade at and not a forecast.

import {
  formatFixed,
  formatSpan,
  formatUtc,
  formatUtcDay,
  groupThousands,
  multiplierRatio,
  relativeTime,
  roundDecimal,
  SESSION_LABELS,
  shortName,
  SNAPSHOT,
  SOURCES,
  STOCK_FACTORY,
  STOCK_IMPLEMENTATION,
  STOCK_REGISTRY,
  type FeedPart,
  type MultiplierUpdate,
  type StockReport,
} from "@hyvo/stocks";
import type { Palette } from "../color.js";
import type { StockFacts, StockList } from "../stocks.js";
import { checkDisclaimer } from "./check.js";
import { factLines, headingLine, paragraph, tableLines, tableWidth, titleLines, type Fact } from "./facts.js";
import { oneLine } from "./text.js";

export interface StocksRenderOptions {
  palette: Palette;
  width: number | null;
  readLine: string;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const isoSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function renderStockList(list: StockList, o: StocksRenderOptions): string {
  const c = o.palette;
  const lines = titleLines(
    "HYVO STOCKS",
    "Robinhood stock tokens",
    [`the StockFactory ${STOCK_FACTORY}`, `scanned up to block ${SNAPSHOT.block} (${formatUtcDay(isoSeconds(SNAPSHOT.time))})`],
    c,
    o.width,
  );
  const total = SNAPSHOT.tokens.length;
  const intro = list.search
    ? `${list.tokens.length} of the ${total} stock tokens ${list.tokens.length === 1 ? "has" : "have"} a ticker or name that contains "${oneLine(list.search, 40)}".`
    : `${total} stock tokens: every token the StockFactory deployed up to block ${SNAPSHOT.block}, A to Z. Names leave out the "• Robinhood Token" each of them ends with.`;
  lines.push("", ...paragraph(intro, o.width));
  if ("error" in list.live) lines.push(...paragraph(`The chain could not be read to check for newer tokens: ${oneLine(list.live.error, 160)}`, o.width, c.gray));
  else {
    const { since, block } = list.live;
    lines.push(
      ...paragraph(
        since <= 0
          ? `Read live at block ${block}: the factory has deployed nothing since.`
          : `Read live at block ${block}: the factory has deployed ${since} more ${since === 1 ? "token" : "tokens"} since. Look ${since === 1 ? "it" : "them"} up by address.`,
        o.width,
      ),
    );
  }
  lines.push("");
  if (list.tokens.length === 0) lines.push(...paragraph(`No ticker or name in the list contains "${oneLine(list.search ?? "", 40)}".`, o.width, c.gray));
  else {
    const head = ["ticker", "contract", "multiplier changes", "name"];
    const rows = (shortened: boolean) =>
      list.tokens.map((token) => [
        oneLine(token.symbol, 14),
        shortened ? short(token.address) : token.address,
        token.multiplierUpdates.length === 0 ? "none" : String(token.multiplierUpdates.length),
        oneLine(shortName(token.name), 44),
      ]);
    const full = rows(false);
    const shorten = o.width !== null && tableWidth(head, full) > o.width;
    lines.push(...tableLines(head, shorten ? rows(true) : full, c));
    if (shorten) lines.push("", ...paragraph("Addresses are shortened to fit this terminal; --json has them in full.", o.width, c.gray));
  }
  lines.push(
    "",
    ...paragraph(
      "The list is Hyvo's scan of the chain alone: the factory's Deployed events, then every multiplier and name change each token recorded. One token's facts, read live: hyvo stocks <ticker|address>",
      o.width,
      c.gray,
    ),
    ...paragraph(o.readLine, o.width, c.gray),
    ...paragraph(checkDisclaimer(BigInt(SNAPSHOT.block)), o.width),
    "",
  );
  return lines.join("\n");
}

function verdictText(report: StockReport): { title: string; body: string } {
  const { reading, verdict } = report;
  const token = reading.token;
  const symbol = token ? oneLine(token.symbol, 16) : null;
  switch (verdict.kind) {
    case "registered":
      return {
        title: `Yes. The Stock Token factory records this contract as ${symbol}.`,
        body: "The factory deployed it and keeps it under its uid: asked for that uid, the factory answers with this address. A copy can take a ticker, a name and a uid, but not this record.",
      };
    case "recorded-elsewhere":
      return {
        title: "No. The factory records a different contract for this uid.",
        body: `This contract carries the uid of a stock token${symbol ? ` and calls itself ${symbol}` : ""}, but asked for that uid, the factory answers with ${verdict.recorded}. That one is the token the factory deployed.`,
      };
    case "unknown-uid":
      return {
        title: "No. The factory has no token for this contract's uid.",
        body: `It answers like a stock token${symbol ? ` and calls itself ${symbol}` : ""}, but the factory does not record it under its uid.`,
      };
    case "not-a-stock-token":
      return {
        title: "No. This contract does not answer like a stock token.",
        body: "It has no uid, multiplier or pause flag to read, so it is not one of the tokens the factory deploys.",
      };
    case "no-code":
      return {
        title: "No contract is deployed at this address.",
        body: "Robinhood Chain has no code at this address at this block: it is an ordinary account, or nothing yet.",
      };
  }
}

function verdictLines(stock: StockFacts, c: Palette, width: number | null): string[] {
  const { report, ticker } = stock;
  const { reading, verdict, listed } = report;
  const token = reading.token;
  const yes = verdict.kind === "registered";
  const { title, body } = verdictText(report);
  const lines = [headingLine(yes ? `Is this the ${oneLine(token!.symbol, 16)} stock token?` : "Is this a Robinhood stock token?", null, c)];
  lines.push(...paragraph(title, width, c.bold), ...paragraph(body, width));
  if (!yes && verdict.kind !== "no-code") {
    lines.push(...paragraph("That is all it says: the factory does not record this contract. It is not a judgment of what the contract does.", width, c.gray));
  }
  if (yes && ticker && token && token.symbol !== ticker) lines.push(...paragraph(`Hyvo's list had it as ${ticker}; its ticker on-chain is now ${oneLine(token.symbol, 16)}.`, width, c.gray));
  if (!token) return lines;
  const facts: Fact[] = [
    { label: "uid", value: token.uid, note: `The token's id, read from uid(). The factory's tokenAddress(uid) ${yes ? "returns this contract" : "is the check above"}.` },
    { label: "name and ticker", value: `${oneLine(token.name, 80)} · ${oneLine(token.symbol, 16)}`, note: "As the contract states them. Any contract can state these." },
  ];
  if (yes) {
    facts.push({
      label: "runs on",
      value: `the Stock contract ${reading.implementation ?? STOCK_IMPLEMENTATION}, behind the registry ${STOCK_REGISTRY}`,
      note: `${report.system.beaconIsRegistry ? "Its proxy's beacon is that registry," : "Its proxy's beacon could not be read; the registry is"} which holds every role, the pause switch and the blocklist. The source is verified on Sourcify: ${SOURCES.stockSource}`,
    });
    facts.push(
      listed
        ? {
            label: "deployed",
            value: `${formatUtc(isoSeconds(listed.deployed.time))}, block ${listed.deployed.block}, as ${oneLine(listed.deployed.symbol, 16)}`,
            note: `By the factory ${STOCK_FACTORY}, in its Deployed event: transaction ${listed.deployed.tx}.`,
          }
        : { label: "deployed", value: `after Hyvo's scan (block ${report.snapshot.block}), so its deployment is not in the list yet` },
    );
    if (token.terms) facts.push({ label: "terms it links", value: oneLine(token.terms, 200), note: "What the contract's terms() returns." });
  }
  lines.push("", ...factLines(facts, c, width));
  return lines;
}

const PER_SHARE_REASONS: Record<string, string> = {
  "oracle-paused": "Not worked out: the oracle is paused, so the feed holds a value from before the pause.",
  "multiplier-changed-since-update": "Not worked out: the multiplier changed after the feed's last update, so the two do not belong together.",
  "multiplier-timing-unknown": "Not worked out: a multiplier change is scheduled, and Hyvo cannot tell when the value in effect started.",
  "no-answer": "Not worked out: the feed has no valid answer.",
};

function priceLines(feed: FeedPart | null, symbol: string, multiplier: string, now: number, c: Palette, width: number | null): string[] {
  const lines = ["", headingLine("What its price is", null, c)];
  const say = (text: string) => [...lines, ...paragraph(text, width)];
  if (!feed) return say("No price was read.");
  switch (feed.kind) {
    case "none":
      return say(`Chainlink's directory lists no tokenized-price feed for ${symbol}, so there is no price on the chain to show. Hyvo does not take prices from anywhere else.`);
    case "several":
      return say(`Chainlink's directory lists ${feed.listings.length} feeds for ${symbol} (${feed.listings.map((listing) => listing.name).join(", ")}). Hyvo does not choose between them.`);
    case "directory-failed":
      return say(`Chainlink's feed directory could not be read just now, so the feed's address is not known: ${oneLine(feed.message, 160)}`);
    case "read-failed":
      return say(`The Chainlink feed ${feed.listing.proxy} could not be read just now: ${oneLine(feed.message, 160)}`);
    case "read":
      break;
  }
  const { listing, reading, price } = feed;
  const facts: Fact[] = [
    price.answered
      ? { label: "per token", value: `${groupThousands(roundDecimal(price.perToken, 2))} USD`, note: `The feed's answer: ${price.perToken} (${price.decimals} decimals).` }
      : { label: "per token", value: "no price", note: `The feed answers ${price.perToken}, which Chainlink says to treat as invalid.` },
    {
      label: "updated",
      value: `${relativeTime(price.updatedAt, now)}, ${formatUtc(price.updatedAt)}`,
      note: `${price.withinHeartbeat ? `Within the feed's ${formatSpan(listing.heartbeatSeconds)} heartbeat.` : `Older than the feed's ${formatSpan(listing.heartbeatSeconds)} heartbeat.`}${listing.deviationPercent !== null ? ` It also updates when the price moves ${listing.deviationPercent}%.` : ""}`,
    },
    {
      label: "what it is",
      value: `The price of one token: the underlying share's 24/5 market price × the multiplier (${multiplier}).`,
      note: `Chainlink calls it the token's Total Return Value and reads the multiplier from the token's uiMultiplier(): ${SOURCES.chainlinkRobinhood}`,
    },
    price.perShare.value !== null
      ? {
          label: "per share",
          value: `${groupThousands(roundDecimal(price.perShare.value, 2))} USD`,
          note: `The answer ÷ the multiplier: Chainlink's formula worked backwards, to ${price.decimals} decimals: ${price.perShare.value}.`,
        }
      : { label: "per share", value: "not worked out", note: PER_SHARE_REASONS[price.perShare.reason] ?? null },
    {
      label: "feed",
      value: `${oneLine(listing.name, 60)} · ${listing.proxy}`,
      note: reading.description ? `On-chain it describes itself as "${oneLine(reading.description, 60)}".` : "It does not describe itself on-chain.",
    },
  ];
  lines.push(...factLines(facts, c, width));
  lines.push(...paragraph(`A reading of the feed at block ${reading.blockNumber}, not a quote to trade at and not a forecast.`, width, c.gray));
  return lines;
}

function multiplierLines(report: StockReport, c: Palette, width: number | null): string[] {
  const token = report.reading.token!;
  const multiplier = report.multiplier!;
  const now = report.reading.blockTime;
  const since = multiplier.inEffectSince;
  const scaled = token.totalSupplyUI;
  const facts: Fact[] = [
    { label: "multiplier", value: roundDecimal(multiplier.value, 6), note: `Exact: ${multiplier.value}, from uiMultiplier().` },
    {
      label: "in effect since",
      value: since === "deployment" ? "deployment: it has never changed" : since === "unknown" ? "not known from the chain alone while a change is scheduled" : formatUtc(since),
    },
    multiplier.scheduled
      ? {
          label: "scheduled",
          value: `becomes ${multiplier.scheduled.value} on ${formatUtc(multiplier.scheduled.effectiveAt)} (${relativeTime(multiplier.scheduled.effectiveAt, now)})`,
          note: "Staged with updateMultiplier(value, effectiveAt): newUIMultiplier() and effectiveAt() hold it until then.",
        }
      : { label: "scheduled", value: "no change is scheduled" },
    {
      label: "supply",
      value: `${groupThousands(roundDecimal(formatFixed(token.totalSupply, token.decimals), 4))} tokens`,
      note: scaled !== null ? `× the multiplier, ${groupThousands(roundDecimal(formatFixed(scaled, token.decimals), 4))}: what totalSupplyUI() returns.` : null,
    },
    {
      label: "what it means",
      value: "Balances are stored as they are, and a wallet that follows ERC-8056 shows them times this number.",
      note: "Chainlink's feed prices one token as the share's price times it, so it rises a little with a dividend reinvestment and jumps with a split.",
    },
  ];
  return ["", headingLine("Multiplier", null, c), ...factLines(facts, c, width)];
}

function oracleLine(oracle: "publishing" | "held" | "unknown", hasFeed: boolean): string {
  if (oracle === "unknown") return "oraclePaused() could not be read.";
  if (oracle === "publishing") {
    return hasFeed ? "oraclePaused() is false, so Chainlink's feed for it keeps updating." : "oraclePaused() is false. Chainlink's feeds honor this flag; none is listed for this token.";
  }
  return hasFeed
    ? "oraclePaused() is true: Chainlink's feed holds its last value while a corporate action is applied."
    : "oraclePaused() is true: the flag Chainlink's feeds honor while a corporate action is applied. None is listed for this token.";
}

function movementLines(facts: StockFacts, c: Palette, width: number | null): string[] {
  const { report, session } = facts;
  const movement = report.movement!;
  const token = report.reading.token!;
  const hasFeed = report.feed?.kind === "read" || report.feed?.kind === "read-failed";
  const pausedBy = [movement.tokenPaused ? "the token's own switch" : null, movement.registryPaused ? "the registry's switch, which pauses every token" : null].filter(Boolean);
  const rows: Fact[] = [
    {
      label: "transfers",
      value: movement.transfers === "open" ? "open" : "paused",
      note:
        movement.transfers === "open"
          ? "paused() is false: transfers and approvals go through, except for accounts on the registry's blocklist."
          : `paused() is true${pausedBy.length ? `, set by ${pausedBy.join(" and ")}` : ""}: transfers, approvals, mints and burns revert until it is lifted.`,
    },
    {
      label: "oracle pause",
      value: movement.oracle === "publishing" ? "not paused" : movement.oracle === "held" ? "paused" : "unknown",
      note: oracleLine(movement.oracle, hasFeed),
    },
    {
      label: "US equity session",
      value: `${session.weekday} ${session.time} in New York: ${SESSION_LABELS[session.session]}`,
      note: `By the clock at this block, using Chainlink's session table; market holidays are not counted.${session.session === "weekend" ? " Chainlink's feed holds its last price until the overnight session opens on Sunday." : ""}`,
    },
  ];
  return [
    "",
    headingLine("Can it move right now?", null, c),
    ...factLines(rows, c, width),
    ...paragraph(
      `On-chain flags of ${oneLine(token.symbol, 16)} at block ${report.reading.blockNumber}. Where and when the token can be bought or sold off the chain is Robinhood's to say, and not read here.`,
      width,
      c.gray,
    ),
  ];
}

function historyRow(update: MultiplierUpdate, replaced: boolean, now: number): Fact {
  const from = formatFixed(BigInt(update.oldMultiplier), 18);
  const to = formatFixed(BigInt(update.newMultiplier), 18);
  const tags = [update.effectiveAt > now ? "scheduled" : null, replaced ? "replaced before it took effect" : null].filter(Boolean).join(", ");
  return {
    label: formatUtc(update.effectiveAt),
    value: `${from} → ${to} (× ${multiplierRatio(BigInt(update.oldMultiplier), BigInt(update.newMultiplier))})${tags ? `, ${tags}` : ""}`,
    note: `Sent ${formatUtc(isoSeconds(update.time))}, block ${update.block}, transaction ${update.tx}.`,
  };
}

function historyLines(report: StockReport, c: Palette, width: number | null): string[] {
  const token = report.reading.token!;
  const listed = report.listed;
  const updates = listed?.multiplierUpdates ?? [];
  const lines = ["", headingLine("Multiplier changes", `Hyvo's scan up to block ${report.snapshot.block}`, c)];
  if (!listed) lines.push(...paragraph(`Hyvo's scan, up to block ${report.snapshot.block}, does not hold this contract, so it has no history to show.`, width));
  else if (updates.length === 0) lines.push(...paragraph(`None up to block ${report.snapshot.block}: the multiplier has been 1.0 since the token was deployed.`, width));
  else {
    const rows = updates.map((update, index) => historyRow(update, index + 1 < updates.length && isoSeconds(updates[index + 1]!.time) < update.effectiveAt, report.reading.blockTime));
    lines.push(...factLines(rows.reverse(), c, width, 26));
  }
  const last = updates[updates.length - 1];
  const changedAfterScan = listed ? (last ? BigInt(last.newMultiplier) !== token.newUIMultiplier || BigInt(last.effectiveAt) !== token.effectiveAt : token.effectiveAt !== 0n) : false;
  if (changedAfterScan) {
    lines.push(...paragraph(`The multiplier was updated after Hyvo's scan: the values above this list are read live, and this list ends at block ${report.snapshot.block}.`, width, c.gray));
  }
  if (listed && listed.metadataUpdates.length > 0) {
    const renames = listed.metadataUpdates.map((meta) => `${formatUtc(isoSeconds(meta.time))} to "${oneLine(meta.name, 60)}" (${oneLine(meta.symbol, 16)})`);
    lines.push(...paragraph(`Name and ticker set again: ${renames.join("; ")}.`, width));
  }
  lines.push(
    ...paragraph(
      "Each row is a UIMultiplierUpdated event. The chain records the numbers, not the reason; Chainlink's page lists the usual ones: a dividend reinvestment raises the multiplier a little, a 10:1 split takes it from 1.0 to 10.0.",
      width,
      c.gray,
    ),
  );
  return lines;
}

export function renderStockFacts(facts: StockFacts, o: StocksRenderOptions): string {
  const c = o.palette;
  const { report } = facts;
  const { reading } = report;
  const token = reading.token;
  const registered = report.verdict.kind === "registered";
  const subject = registered && token ? `${oneLine(token.symbol, 16)} · ${oneLine(shortName(token.name), 60)}` : `Contract ${short(reading.address)}`;
  const lines = titleLines("HYVO STOCKS", subject, [reading.address, `block ${reading.blockNumber}`, formatUtc(reading.blockTime)], c, o.width);
  lines.push("", ...verdictLines(facts, c, o.width));
  if (registered && token && report.multiplier) {
    lines.push(...priceLines(report.feed, oneLine(token.symbol, 16), report.multiplier.value, reading.blockTime, c, o.width));
    lines.push(...multiplierLines(report, c, o.width));
    lines.push(...movementLines(facts, c, o.width));
    lines.push(...historyLines(report, c, o.width));
  }
  const provenance: string[] = [];
  if (report.feed?.kind === "read") {
    const fetched = report.directoryFetchedAt ? formatUtc(isoSeconds(report.directoryFetchedAt)) : "just now";
    provenance.push(`The price is the Chainlink feed's answer at the same block; Hyvo took the feed's address from Chainlink's reference data directory, fetched ${fetched}.`);
  }
  if (registered) provenance.push(`The history comes from Hyvo's scan of the chain up to block ${report.snapshot.block} (${formatUtc(isoSeconds(report.snapshot.time))}).`);
  lines.push("");
  if (provenance.length > 0) lines.push(...paragraph(provenance.join(" "), o.width, c.gray));
  lines.push(...paragraph(o.readLine, o.width, c.gray), ...paragraph(checkDisclaimer(reading.blockNumber), o.width), "");
  return lines.join("\n");
}
