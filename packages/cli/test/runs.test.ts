import { describe, expect, it } from "vitest";
import { run, SAMPLE_RUN, testContext, type Route } from "./helpers";

const API = "https://api.hyvo.run";

function listing(extra: Record<string, unknown> = {}) {
  return {
    runs: [{ ...SAMPLE_RUN.summary, publishedAt: "2026-11-02T12:30:00Z", featured: true, ...extra }],
    nextCursor: "c2VlIG1l",
    disclaimer: "Synthetic crowd reaction. Not a trading signal.",
  };
}

const routes = (body: unknown, status = 200): Route[] => [(url) => (url.origin === API && url.pathname === "/v1/runs" ? { status, body } : undefined)];

describe("hyvo runs", () => {
  it("lists the published runs with what each simulated, and the disclaimer", async () => {
    const c = testContext({ routes: routes(listing()) });
    expect(await run(["runs"], c)).toBe(0);
    const out = c.stdout();
    expect(c.requests.map((r) => r.url)).toEqual([`${API}/v1/runs?limit=10`]);
    expect(out).toContain("HYVO RUNS   published, newest first · api.hyvo.run");
    expect(out).toContain(`${SAMPLE_RUN.runId}   published 2026-11-02 12:30:00 UTC · complete`);
    expect(out).toContain("Thin-liquidity launch with a deployer rumor");
    expect(out).toContain("3 agents · 2 rounds · simulated HYVX price 0.00001 → 0.000011024659555802 (+10.25%) · 3 swaps · 5 posts");
    expect(out).toContain(`hash ${SAMPLE_RUN.meta.hash}`);
    expect(out).toContain("More: hyvo runs --cursor c2VlIG1l");
    expect(out.trimEnd().split("\n").at(-1)).toBe("  Synthetic crowd reaction. Not a trading signal.");
  });

  it("passes --limit and --cursor to the API", async () => {
    const c = testContext({ routes: routes(listing()) });
    await run(["runs", "--limit", "3", "--cursor", "abc"], c);
    expect(c.requests[0]!.url).toBe(`${API}/v1/runs?limit=3&cursor=abc`);
  });

  it("prints the API's answer as JSON, disclaimer included", async () => {
    const c = testContext({ routes: routes(listing()) });
    expect(await run(["runs", "--json"], c)).toBe(0);
    expect(JSON.parse(c.stdout())).toEqual(listing());
  });

  it("refuses a --limit outside 1 to 50", async () => {
    for (const limit of ["0", "51", "ten"]) {
      const c = testContext();
      expect(await run(["runs", "--limit", limit], c), limit).toBe(64);
      expect(c.requests).toEqual([]);
    }
  });

  it("exits 2 with the API's own message, or when the answer has a shape it does not know", async () => {
    const limited = testContext({ routes: routes({ error: { code: "rate_limited", message: "slow down" } }, 429) });
    expect(await run(["runs", "--json"], limited)).toBe(2);
    expect(JSON.parse(limited.stdout())).toEqual({ error: { code: "rate_limited", message: "api.hyvo.run answered 429: slow down" } });

    const drifted = testContext({ routes: routes(listing({ somethingNew: 1 })) });
    expect(await run(["runs"], drifted)).toBe(2);
    expect(drifted.stderr()).toContain("answered in a shape this version of hyvo does not know");
  });
});
