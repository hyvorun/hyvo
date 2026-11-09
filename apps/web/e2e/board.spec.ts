import { DEMO_LAUNCHES } from "@hyvo/launches/testing";
import { expect, test, type Page } from "@playwright/test";
import { stubApi } from "./stub-api";
import { stubBoardChain } from "./stub-board";

const FIZZ = DEMO_LAUNCHES[0]!;

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the board shows its three columns, read at one named block", async ({ page }) => {
  await stubBoardChain(page);
  await page.goto("/board");
  await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible();
  await expect(page.getByText("Every Pons launch on Robinhood Chain, live: new, close to graduating, graduated.")).toBeVisible();

  const fresh = page.getByRole("region", { name: "New" });
  const stretch = page.getByRole("region", { name: "Final stretch" });
  const graduated = page.getByRole("region", { name: "Graduated" });
  const cards = (region: typeof fresh) => region.getByRole("list").first().locator(":scope > li");
  // Launched in the last hour and below half way, newest first. DRIP and MOTE are past half way already.
  await expect(cards(fresh)).toHaveCount(3, { timeout: 20_000 });
  await expect(cards(fresh).nth(0)).toContainText("FIZZ");
  await expect(cards(fresh).nth(1)).toContainText("GLINT");
  await expect(cards(fresh).nth(2)).toContainText("PLUME");
  // On the curve and past half way, furthest first: DRIP's curve holds its threshold, OSPREY 73.8%, MOTE 60%.
  await expect(cards(stretch)).toHaveCount(3);
  await expect(cards(stretch).nth(0)).toContainText("DRIP");
  await expect(cards(stretch).nth(1)).toContainText("OSPREY");
  await expect(cards(stretch).nth(2)).toContainText("MOTE");
  await expect(cards(stretch).nth(2)).toContainText("60%");
  // Its pool created in the last 24 hours.
  await expect(cards(graduated)).toHaveCount(1);
  await expect(cards(graduated).first()).toContainText("BRISK");
  await expect(cards(graduated).first()).toContainText("Creator tax 10%");

  // FIZZ: the creator's wallet, the curve and the two wallets of the launch second, as shares of the supply.
  const fizz = cards(fresh).first();
  await expect(fizz.getByRole("list", { name: "Flags for FIZZ" })).toContainText("Creator holds 62%");
  await expect(fizz.getByRole("list", { name: "Flags for FIZZ" })).toContainText("First-second buyers hold 18%");
  await expect(fizz).toContainText("Still on the curve20%");
  await expect(fizz).toContainText("(2 wallets)");
  await expect(fizz).toContainText("ETH");

  await expect(page.getByText(/^Read at block 109,867,700/)).toBeVisible();
  await expect(page.getByText("Measured on-chain at block 109,867,700. Not a trading signal.", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/\b(safe|scam|rug|honeypot|legit|larp|rigged|sketchy|risky|risk|pump|moon|gem|red flag|verdict|score)\b/i);
  await noHorizontalScroll(page);
});

test("a card opens its launch page, and its small link goes to Hyvo Check", async ({ page }) => {
  await stubBoardChain(page);
  await page.goto("/board");
  const fizz = page.getByRole("region", { name: "New" }).getByRole("listitem").first();
  await expect(fizz.getByRole("link", { name: "Check FIZZ with Hyvo Check" })).toHaveAttribute("href", `/check/${FIZZ.token}`, { timeout: 20_000 });
  const open = fizz.getByRole("link", { name: /^FIZZ/ });
  await expect(open).toHaveAttribute("href", `/launches/${FIZZ.token}`);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/launches/${FIZZ.token}$`));
  await expect(page.getByRole("heading", { name: "FIZZ", level: 1 })).toBeVisible();
});

test("on a phone the columns become tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubBoardChain(page);
  await page.goto("/board");
  const tabs = page.getByRole("tablist", { name: "Columns" });
  await expect(page.getByRole("region", { name: "New" })).toContainText("FIZZ", { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Final stretch" })).toBeHidden();
  await tabs.getByRole("tab", { name: /^Final stretch/ }).click();
  await expect(page.getByRole("region", { name: "Final stretch" })).toContainText("OSPREY");
  await expect(page.getByRole("region", { name: "New" })).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: /^Graduated/ })).toBeFocused();
  await expect(page.getByRole("region", { name: "Graduated" })).toContainText("BRISK");
  await noHorizontalScroll(page);
});

test("when the chain does not answer, the board says so and can try again", async ({ page }) => {
  await stubBoardChain(page, { down: true });
  await page.goto("/board");
  await expect(page.getByRole("alert")).toContainText("Robinhood Chain's public endpoints did not answer just now.", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the header and the footer reach the board", async ({ page }) => {
  await stubApi(page);
  await stubBoardChain(page);
  await page.goto("/tools");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Board" }).click();
  await expect(page).toHaveURL(/\/board$/);
  await expect(page.locator("header").getByRole("link", { name: "Board" })).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: "Board" })).toHaveClass(/active/);
});
