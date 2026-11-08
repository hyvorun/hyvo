import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, formatTokenAmount, formatUsd, toRequest, type Draft } from "../src/lib/draft";

const draft = (patch: Partial<Draft>): Draft => ({ ...EMPTY_DRAFT, title: "Fictional token FIZZ lists", ...patch });

describe("toRequest", () => {
  it("builds the quote request the API expects", () => {
    const { request, errors } = toRequest(
      draft({
        seedText: "  FIZZ is fictional.  ",
        events: [{ round: "3", text: " A whale enters. " }],
        tokenSymbol: "fizz",
        liquidityEth: "5",
        feePct: "2.5",
        agents: "200",
        rounds: "15",
        listed: false,
      }),
    );
    expect(errors).toEqual({});
    expect(request).toEqual({
      scenario: {
        title: "Fictional token FIZZ lists",
        seedText: "FIZZ is fictional.",
        events: [{ round: 3, text: "A whale enters." }],
        market: { tokenSymbol: "FIZZ", liquidityEth: "5", feeBps: 250 },
      },
      agents: 200,
      rounds: 15,
      listed: false,
    });
  });

  it("leaves the market out when no field is set", () => {
    expect(toRequest(draft({})).request?.scenario).not.toHaveProperty("market");
  });

  it.each([
    [{ title: "" }, "title"],
    [{ title: "!!!" }, "title"],
    [{ title: `A${"x".repeat(200)}` }, "title"],
    [{ seedText: "x".repeat(4001) }, "seedText"],
    [{ agents: "9" }, "agents"],
    [{ agents: "2001" }, "agents"],
    [{ agents: "ten" }, "agents"],
    [{ rounds: "2" }, "rounds"],
    [{ events: [{ round: "11", text: "late" }] }, "events.0.round"],
    [{ events: [{ round: "0", text: "early" }] }, "events.0.round"],
    [{ events: [{ round: "2", text: "  " }] }, "events.0.text"],
    [{ tokenSymbol: "FIZZ-1" }, "market.tokenSymbol"],
    [{ liquidityEth: "0" }, "market.liquidityEth"],
    [{ liquidityEth: "1e3" }, "market.liquidityEth"],
    [{ feePct: "10.5" }, "market.feeBps"],
    [{ feePct: "1.234" }, "market.feeBps"],
  ])("puts the error for %j on its field", (patch, field) => {
    const { request, errors } = toRequest(draft(patch as Partial<Draft>));
    expect(request).toBeNull();
    expect(Object.keys(errors)).toContain(field);
  });

  it("refuses six events in one round with the API's message", () => {
    const events = Array.from({ length: 6 }, (_, i) => ({ round: "2", text: `event ${i}` }));
    const { request, errors } = toRequest(draft({ events }));
    expect(request).toBeNull();
    expect(errors["scenario.events"]).toMatch(/more than 5 events/);
  });
});

describe("amounts", () => {
  it("formats token base units and dollars", () => {
    expect(formatTokenAmount("1000000", 6)).toBe("1.00");
    expect(formatTokenAmount("8000000", 6)).toBe("8.00");
    expect(formatTokenAmount("500000", 6)).toBe("0.50");
    expect(formatTokenAmount("1234567890", 6)).toBe("1,234.56");
    expect(formatTokenAmount(`${10n ** 18n * 3n}`, 18)).toBe("3.00");
    expect(formatUsd(7)).toBe("$7.00");
  });
});
