import { DISCLAIMER } from "@hyvo/schema";
import { expect, test } from "@playwright/test";
import { golden, stubApi, summary } from "./stub-api";

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

async function noHorizontalScroll(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the home page plays the featured run", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Launch it in a parallel world first.");
  await expect(page.getByRole("link", { name: new RegExp(golden.scenario.title) }).first()).toBeVisible();
  const chart = page.getByRole("img", { name: /Price trace/ });
  await expect(chart).toBeVisible();
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  // The console autoplays: its round counter moves past round 1.
  await expect(page.getByText(/^Round ([2-9]|10) of 10$/)).toBeVisible({ timeout: 20_000 });
  await noHorizontalScroll(page);
});

test("the replay page replays the golden run end to end", async ({ page }) => {
  await page.goto(`/run/${golden.runId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(golden.scenario.title);
  await expect(page.getByText("Hash verified in your browser")).toBeVisible();

  // It opens at the end of the run: round 10 and the overall price change.
  const slider = page.getByRole("slider", { name: "Replay position" });
  await expect(page.getByText("R10/10")).toBeVisible();
  await expect(page.getByText(`+${summary.market.priceChangePct.toFixed(1)}%`).first()).toBeVisible();

  // The feed keeps the run's history, marked by round, and every post carries the synthetic agent label.
  const lastRound = golden.rounds.at(-1)!;
  const posts = page.getByRole("tabpanel").locator("article");
  await expect(posts.first()).toBeVisible();
  const shown = await posts.count();
  expect(shown).toBeGreaterThan(lastRound.posts.length);
  await expect(page.getByText("synthetic agent", { exact: true })).toHaveCount(shown);
  await expect(page.getByRole("tabpanel").getByText("Round 9", { exact: true })).toBeVisible();

  // A step back into round 9 keeps what was said before it on screen.
  await slider.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.getByText("R9/10")).toBeVisible();
  await expect(page.getByRole("tabpanel").locator("article").first()).toBeVisible();

  // Scrubbing back to the start shows round 1 before anyone posted.
  await page.keyboard.press("Home");
  await expect(page.getByText("R1/10")).toBeVisible();
  await expect(page.getByText("No posts yet.")).toBeVisible();

  // Playing advances the replay.
  await page.getByRole("button", { name: /Play replay/ }).click();
  await expect(page.getByRole("tabpanel").locator("article").first()).toBeVisible({ timeout: 15_000 });

  // The trades tab lists executed swaps of the round.
  await page.getByRole("tab", { name: /Trades/ }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();

  // The report and the disclaimer are on the page.
  await expect(page.getByRole("heading", { name: "What the crowd did" })).toBeVisible();
  await expect(page.getByText(golden.report.summary)).toBeVisible();
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  await noHorizontalScroll(page);
});

test("the gallery lists the run and opens its replay", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "Published runs" })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(golden.scenario.title) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/run/${golden.runId}$`));
  await expect(page.getByText("Hash verified in your browser")).toBeVisible();
  await noHorizontalScroll(page);
});

test("the browser tab says which page this is", async ({ page }) => {
  await page.goto("/runs");
  await expect(page).toHaveTitle("Published runs · Hyvo");
  await page.goto(`/run/${golden.runId}`);
  await expect(page).toHaveTitle(`${golden.scenario.title} · Hyvo`);
  await page.goto("/");
  await expect(page).toHaveTitle("Hyvo: launch it in a parallel world first");
});

test("a page that fails to load keeps the site around it and offers a reload", async ({ page }) => {
  await page.route("**/*NewRunPage*", (route) => route.abort());
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).waitFor();
  await page.getByRole("link", { name: /Run a simulation|New run/ }).first().click();
  await expect(page.getByRole("heading", { name: "This page could not be shown" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Hyvo home" }).first()).toBeVisible();
});

test("the home and run pages do not load the wallet and chain code", async ({ page }) => {
  const loaded: string[] = [];
  page.on("request", (request) => loaded.push(request.url()));
  await page.goto("/");
  await expect(page.getByRole("slider", { name: "Replay position" })).toBeVisible();
  await page.goto(`/run/${golden.runId}`);
  await expect(page.getByText("Hash verified in your browser")).toBeVisible();
  expect(loaded.filter((url) => /viem|wagmi|secp256k1|lib\/chain/.test(url))).toEqual([]);
});

test("an unknown run says so and links to the gallery", async ({ page }) => {
  await page.goto("/run/run_01M6FTAPSWS9Q5KVY5BT34XMZZ");
  await expect(page.getByRole("alert")).toContainText("No run has this id");
  await expect(page.getByRole("link", { name: /Browse runs/ })).toBeVisible();
});

test("with no run published, the home page says so and still explains itself", async ({ page }) => {
  await page.route("http://api.test/v1/runs/featured", (route) =>
    route.fulfill({
      status: 404,
      headers: { "Access-Control-Allow-Origin": "*" },
      json: { error: { code: "not_found", message: "No run is featured." } },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("No run is published yet. The first published run will play here.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "How a run works" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an answer the page cannot read is explained, not printed", async ({ page }) => {
  await page.route("http://api.test/v1/runs/featured", (route) =>
    route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, json: { run: null } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("The Hyvo API sent an answer this page cannot read.");
  await expect(page.getByRole("alert")).not.toContainText("invalid_type");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a title with one very long word does not break the page", async ({ page }) => {
  const long = { ...summary, title: "A".repeat(180) };
  const headers = { "Access-Control-Allow-Origin": "*" };
  await page.route("http://api.test/v1/runs?*", (route) =>
    route.fulfill({ status: 200, headers, json: { runs: [long], nextCursor: null, disclaimer: DISCLAIMER } }),
  );
  await page.goto("/runs");
  await expect(page.getByRole("link", { name: long.title })).toBeVisible();
  await noHorizontalScroll(page);
  const row = await page.getByRole("link", { name: long.title }).boundingBox();
  expect(row!.x + row!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
