import { DISCLAIMER } from "@hyvo/schema";
import { expect, test, type Page } from "@playwright/test";
import { PRODUCTS } from "../src/lib/products";
import { ADDRESSES, golden, stubApi, summary } from "./stub-api";

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

const CLOSED = {
  ok: true,
  version: "test",
  features: { payments: false, oracle: true, holder: false, clone: false },
  limits: { minAgents: 10, maxAgents: 500, minRounds: 3, maxRounds: 30, maxDecisions: 840 },
};

async function closePayments(page: Page) {
  await page.route("http://api.test/v1/health", (route) => route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, json: CLOSED }));
}

test("the run's path shows each step with what the featured run did there", async ({ page }) => {
  await page.goto("/");
  const path = page.getByRole("region", { name: "Every number above comes from one run you can check." });
  // The golden run played on a plain local chain, so its first step says so; the stub has it committed in block 16.
  await expect(path.getByRole("heading", { level: 3 })).toHaveText([
    /Start a private chain/,
    /Seat a crowd of archetypes/,
    /Hand it the scenario/,
    /Let it play, round by round/,
    /Read it back, and check every line/,
    /Seal it in one hash/,
    /Commit the hash to the real chain/,
  ]);
  await expect(path.getByText("from the test chain it played on to the block that holds its hash", { exact: false })).toBeVisible();
  await expect(path.getByText(/^A plain local test chain, not a fork of Robinhood Chain\./)).toBeVisible();
  await expect(path.getByText(/50 agents: 10 snipers, 15 holders, 10 panic sellers and 15 skeptics\./)).toBeVisible();
  await expect(path.getByText(golden.scenario.title, { exact: true })).toBeVisible();
  await expect(path.locator("p", { hasText: "decisions" })).toContainText(`${golden.crowd.size * golden.rounds.length} decisions`);
  await expect(path.getByRole("img", { name: /pool's price after each of 10 rounds/ })).toBeVisible();
  await expect(path.getByText(/^Transaction/)).toBeVisible();
  await expect(path.getByRole("link", { name: "Verify this run" })).toHaveAttribute("href", `/oracle?run=${golden.runId}`);
  await expect(path.getByText(DISCLAIMER)).toBeVisible();
});

test("a commit that cannot be read is not called missing, and can be read again", async ({ page }) => {
  // Every read fails until the test lets them through (the dev build mounts twice, so counting calls would not do).
  let failing = true;
  await page.route(`http://api.test/v1/runs/${golden.runId}`, (route) =>
    failing
      ? route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" }, json: { error: { code: "unavailable", message: "Try again." } } })
      : route.fallback(),
  );
  await page.goto("/");
  const path = page.getByRole("region", { name: "Every number above comes from one run you can check." });
  await expect(path.getByText("The commit could not be read just now.")).toBeVisible();
  await expect(path.getByText(/not committed/)).toHaveCount(0);
  failing = false;
  await path.getByRole("button", { name: "Try again" }).click();
  await expect(path.getByText(/^Transaction/)).toBeVisible();
});

test("a commit the API is retrying says so", async ({ page }) => {
  await page.route(`http://api.test/v1/runs/${golden.runId}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      json: {
        run: summary,
        job: null,
        oracle: { status: "failed", txHash: null, blockNumber: null, chainId: 4663, oracleAddress: ADDRESSES.oracle },
        disclaimer: DISCLAIMER,
      },
    }),
  );
  await page.goto("/");
  const path = page.getByRole("region", { name: "Every number above comes from one run you can check." });
  await expect(path.getByText("Its commit to Robinhood Chain is being retried.")).toBeVisible();
});

test("tabbing into a block that has not scrolled in shows it at once", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("region", { name: "What you can do with Hyvo" }).getByRole("listitem").filter({ hasText: "Free tools" });
  await row.getByRole("link", { name: "Free tools" }).focus();
  await expect(row).toHaveAttribute("data-in", "true");
  await expect(row).toHaveCSS("opacity", "1");
});

test("a link to a section of the docs lands on that section", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Check a hash yourself" }).click();
  await expect(page).toHaveURL(/\/docs#verify$/);
  const section = page.getByRole("heading", { name: "Verify a hash" });
  await expect(section).toBeInViewport();
});

test("the archetype guide follows the arrow keys", async ({ page }) => {
  await page.goto("/");
  const list = page.getByRole("tablist", { name: "Trader archetypes" });
  const panel = page.locator("#archetype-panel");
  await expect(list.getByRole("tab")).toHaveCount(10);
  // The featured run seated four kinds; the list says how many of each.
  await expect(list.getByRole("tab", { name: "Holder 15 in the run above" })).toBeVisible();

  await list.getByRole("tab", { name: /^Sniper/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("tab", { name: /^Holder/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText("Believes in the project and stays through the swings.");
  await page.keyboard.press("End");
  await expect(list.getByRole("tab", { name: /^Newcomer/ })).toBeFocused();
  await expect(panel).toContainText("Newcomer");
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("tab", { name: /^Sniper/ })).toHaveAttribute("aria-selected", "true");

  await list.getByRole("tab", { name: /^Whale/ }).click();
  await expect(panel).toContainText("Moves size in pieces");
  await expect(panel.getByText("Reacts to")).toBeVisible();
});

test("what is open comes from the API's switches", async ({ page }) => {
  await page.goto("/");
  const rows = page.getByRole("region", { name: "What you can do with Hyvo" }).getByRole("listitem");
  // One row per product in the shared list (src/lib/products.ts).
  await expect(rows).toHaveCount(PRODUCTS.length);
  // The stub has payments and clones on.
  await expect(rows.filter({ hasText: "Simulations" })).toContainText("Live");
  await expect(rows.filter({ hasText: "Wallet Clone" })).toContainText("Live");
  await expect(rows.filter({ hasText: "Simulations" }).getByRole("link", { name: "Simulations" })).toHaveAttribute("href", "/new");
});

test("with payments closed, the parts that need them say so, and so do the answers", async ({ page }) => {
  await closePayments(page);
  await page.goto("/");
  const rows = page.getByRole("region", { name: "What you can do with Hyvo" }).getByRole("listitem");
  await expect(rows.filter({ hasText: "Simulations" })).toContainText("Opens with paid runs");
  await expect(rows.filter({ hasText: "Dry Run" })).toContainText("Opens with paid runs");
  await expect(rows.filter({ hasText: "Wallet Clone" })).toContainText("Not open yet");
  await expect(rows.filter({ hasText: "API, MCP and webhooks" })).toContainText("Live for reading");
  await expect(rows.filter({ hasText: "Replays" })).toContainText("Live");

  const questions = page.getByRole("region", { name: "Questions" });
  await questions.getByText("What does a run cost?").click();
  await expect(questions.getByText(/^Paid runs are not open yet\. When they open/)).toBeVisible();
});

test("the questions open and close", async ({ page }) => {
  await page.goto("/");
  const questions = page.getByRole("region", { name: "Questions" });
  const answer = questions.getByText(/a run is one sample of how such a crowd might react/);
  await expect(answer).toBeHidden();
  await questions.getByText("Is a run a prediction?").click();
  await expect(answer).toBeVisible();
  await questions.getByText("Is a run a prediction?").click();
  await expect(answer).toBeHidden();
});

test("the token section says a token is coming and what holding it is for, nothing more", async ({ page }) => {
  await page.goto("/");
  const token = page.getByRole("region", { name: "The HYVO token" });
  await expect(token.getByText("A HYVO token is coming.", { exact: false })).toBeVisible();
  await expect(token.getByRole("listitem")).toHaveCount(3);
  await expect(token).not.toContainText(/yield|revenue|payout|fee/i);
  await expect(token.getByRole("link", { name: "What the token is for" })).toHaveAttribute("href", "/token");
});

test("the long home page never scrolls sideways", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Questions", level: 2 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the header and the footer link Hyvo's official X account", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByRole("link", { name: "Hyvo on X, @Hyvorun" })).toHaveAttribute("href", "https://x.com/Hyvorun");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "X (@Hyvorun)" })).toHaveAttribute("href", "https://x.com/Hyvorun");
});
