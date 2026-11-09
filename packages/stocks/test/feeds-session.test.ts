import { describe, expect, it } from "vitest";
import { feedForTicker, parseFeedDirectory } from "../src/feeds";
import { usEquitySession } from "../src/session";
import { fixture } from "./helpers";

const directory = fixture<{ entries: Record<string, unknown>[] }>("feed-directory.subset.json").entries;

describe("Chainlink's feed directory", () => {
  const listings = parseFeedDirectory(directory);

  it("keeps the tokenized-equity feeds, with the ticker from the feed's name", () => {
    const nvda = feedForTicker(listings, "NVDA");
    expect(nvda.kind).toBe("one");
    if (nvda.kind !== "one") return;
    expect(nvda.listing).toMatchObject({
      ticker: "NVDA",
      name: "Robinhood NVDA / USD",
      proxy: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
      decimals: 8,
      heartbeatSeconds: 86400,
      deviationPercent: 0.5,
      marketHours: "us_equities_24/5",
    });
    // "Robinhood DELL-USD": the dash form of the name.
    expect(feedForTicker(listings, "dell").kind).toBe("one");
  });

  it("skips feeds that are not labeled as a tokenized price", () => {
    // The directory lists "Robinhood SGOV-USD" without saying what kind of price it is, and 24/7 feeds
    // that Chainlink computes another way.
    expect(directory.some((entry) => entry.name === "Robinhood SGOV-USD")).toBe(true);
    expect(feedForTicker(listings, "SGOV").kind).toBe("none");
    expect(listings.some((listing) => listing.name.includes("24/7"))).toBe(false);
  });

  it("reports two feeds for one ticker instead of choosing", () => {
    const twice = [...listings, { ...listings[0]!, proxy: "0x0000000000000000000000000000000000000001" as const }];
    expect(feedForTicker(twice, listings[0]!.ticker).kind).toBe("several");
  });

  it("fails loudly when the format changes", () => {
    expect(() => parseFeedDirectory({ feeds: [] })).toThrow(/list/);
    expect(() => parseFeedDirectory([{ name: "BTC / USD" }])).toThrow(/no Robinhood/);
  });
});

describe("the US equity session by the New York clock", () => {
  const at = (iso: string) => usEquitySession(new Date(iso)).session;

  it("follows Chainlink's session table in winter time", () => {
    expect(at("2026-11-09T09:00:00Z")).toBe("pre-market"); // Mon 04:00 EST
    expect(at("2026-11-09T14:29:00Z")).toBe("pre-market"); // Mon 09:29
    expect(at("2026-11-09T14:30:00Z")).toBe("regular"); // Mon 09:30
    expect(at("2026-11-09T21:00:00Z")).toBe("post-market"); // Mon 16:00
    expect(at("2026-11-10T01:00:00Z")).toBe("overnight"); // Mon 20:00
    expect(at("2026-11-14T01:30:00Z")).toBe("weekend"); // Fri 20:30
    expect(at("2026-11-14T15:00:00Z")).toBe("weekend"); // Sat
    expect(at("2026-11-15T23:30:00Z")).toBe("weekend"); // Sun 18:30
    expect(at("2026-11-16T01:30:00Z")).toBe("overnight"); // Sun 20:30
  });

  it("moves with daylight saving time", () => {
    expect(at("2026-07-06T13:30:00Z")).toBe("regular"); // Mon 09:30 EDT
    expect(at("2026-07-06T13:29:00Z")).toBe("pre-market");
    expect(usEquitySession(new Date("2026-07-06T13:30:00Z"))).toEqual({ session: "regular", weekday: "Mon", time: "09:30" });
  });
});
