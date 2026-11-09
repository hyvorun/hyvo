import { DEMO_ASSETS, DEMO_LAUNCHES, DEMO_V1 } from "@hyvo/launches/testing";
import { expect, test, type Page } from "@playwright/test";
import { stubLaunchChain } from "./stub-launches";

const FIZZ = DEMO_LAUNCHES[0]!;
const GLINT = DEMO_LAUNCHES[2]!;

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the index lists the newest launches with their facts, read at one named block", async ({ page }) => {
  await stubLaunchChain(page);
  await page.goto("/launches");
  await expect(page.getByRole("heading", { name: "Every Pons launch, read from the chain", level: 1 })).toBeVisible();
  const status = page.getByText(/^Measured on-chain at block/).first();
  await expect(status).toContainText("109,867,700");
  await expect(status).toContainText("Not a trading signal.");
  await expect(status).toContainText("Read in your browser through rpc.test");

  const stats = page.getByRole("list", { name: "The last 6 hours on Pons" });
  await expect(stats.getByRole("listitem").filter({ hasText: "Launches in the last 6 hours" })).toContainText("10");
  await expect(stats.getByRole("listitem").filter({ hasText: "Graduated in the last 6 hours" })).toContainText("1");

  const newest = page.getByRole("region", { name: "Newest launches" });
  const rows = newest.getByRole("listitem");
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText("FIZZ");
  await expect(rows.first()).toContainText("3 min");
  const glint = rows.filter({ hasText: "GLINT" });
  await expect(glint).toContainText("USDG");
  await expect(glint).toContainText("642.9 USDG");
  await expect(glint).toContainText("7.9%");
  await expect(glint).toContainText("2%");
  await expect(rows.filter({ hasText: "BRISK" })).toContainText("Graduated");
  // The launch from a day ago is outside the window.
  await expect(newest).not.toContainText("EMBER");
  await noHorizontalScroll(page);
});

test("the most traded count only real Pons curves", async ({ page }) => {
  await stubLaunchChain(page);
  await page.goto("/launches");
  const movers = page.getByRole("region", { name: "Most traded in the last 15 minutes" });
  const items = movers.getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("FIZZ");
  await expect(items.nth(0)).toContainText("27 trades");
  await expect(items.nth(0)).toContainText("15 traders");
  // Launched a day ago, so not among the launches read: checked against the factory's record.
  await expect(items.nth(1)).toContainText("EMBER");
  await expect(items.nth(2)).toContainText("MOTE");
  await expect(movers).toContainText("One other contract sent the same events and is not a Pons curve, so it is left out.");
  await items.nth(1).getByRole("link").click();
  await expect(page).toHaveURL(/\/launches\/0x/);
  await expect(page.getByRole("heading", { name: "EMBER", level: 1 })).toBeVisible();
});

test("the map draws one system per pair asset, and a keyboard opens one", async ({ page }) => {
  await stubLaunchChain(page);
  await page.goto("/launches");
  const map = page.getByRole("group", { name: /^Launches by pair asset/ });
  // Most launches first; NVDA and TSLA tie, and their order follows their addresses.
  await expect(map).toHaveAttribute("aria-label", /^Launches by pair asset: ETH 6, USDG 2, (NVDA 1, TSLA 1|TSLA 1, NVDA 1)$/);
  const region = page.getByRole("region", { name: "By pair asset" });
  await expect(region.getByRole("heading", { name: /Paired with ETH/ })).toBeVisible();
  const usdg = map.getByRole("button", { name: /^USDG: 2 launches, 0 graduated/ });
  await usdg.focus();
  await page.keyboard.press("Enter");
  await expect(usdg).toHaveAttribute("aria-pressed", "true");
  const list = region.getByRole("heading", { name: /Paired with USDG/ });
  await expect(list).toBeVisible();
  await expect(region.getByRole("link", { name: /GLINT/ })).toHaveAttribute("href", `/launches/${GLINT.token}`);
  await expect(region.getByText("A pair asset, sized by its launches")).toBeVisible();
  await noHorizontalScroll(page);
});

test("one launch shows its facts, its last hour of trades and a link to Hyvo Check", async ({ page }) => {
  await stubLaunchChain(page);
  await page.goto(`/launches/${FIZZ.token}`);
  await expect(page.getByRole("heading", { name: "FIZZ", level: 1 })).toBeVisible();
  // Its name only repeats the symbol, so it is not shown twice.
  await expect(page.getByText("Fizz", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Summary" })).toContainText("Paired with ETH");
  await expect(page.getByRole("list", { name: "Summary" })).toContainText("Creator tax 0%");
  await expect(page.getByText(/^Measured on-chain at block 109,867,700/)).toContainText("Not a trading signal.");
  await expect(page.getByText(/of the way to graduation/)).toContainText("1.4%");

  const facts = page.getByRole("region", { name: "On-chain facts" });
  await expect(facts).toContainText("ETH, the chain's own currency");
  await expect(facts).toContainText("On its curve");
  await expect(facts).toContainText("99%, gone after 3 s");
  // The launch transaction, found from the launch time.
  await expect(facts.getByRole("link", { name: /^transaction 0x/ })).toBeVisible();

  const trades = page.getByRole("region", { name: "The last hour on its curve" });
  await expect(trades).toContainText("18 buys and 9 sells.");
  await expect(trades.getByRole("definition").filter({ hasText: /^15/ })).toBeVisible();
  await expect(trades.getByRole("listitem")).toHaveCount(10);

  await expect(page.getByRole("link", { name: "Check this token with Hyvo Check" })).toHaveAttribute("href", `/check/${FIZZ.token}`);
  await expect(page.locator("main")).not.toContainText(/\b(safe|scam|rug|legit|buy now|sell now)\b/i);
  await noHorizontalScroll(page);
});

test("a V1 token, an address that is no launch, and a mistyped address each say so", async ({ page }) => {
  await stubLaunchChain(page);
  await page.goto(`/launches/${DEMO_V1.token}`);
  await expect(page.getByText("Pons V1 launch")).toBeVisible();
  await expect(page.getByRole("heading", { name: "OLDIE", level: 1 })).toBeVisible();
  await expect(page.getByText(/each token starts in a Uniswap V3 pool against WETH, at a 1% fee/)).toBeVisible();

  await page.goto(`/launches/${DEMO_ASSETS.usdg.address}`);
  await expect(page.getByRole("heading", { name: "USDG is not a Pons V2 launch", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Check this address with Hyvo Check" })).toHaveAttribute("href", `/check/${DEMO_ASSETS.usdg.address}`);

  await page.goto("/launches/0x1234");
  await expect(page.getByRole("heading", { name: "That is not a token address", level: 1 })).toBeVisible();
});

test("looking a token up checks the address, and a shorter window keeps only its launches", async ({ page }) => {
  await stubLaunchChain(page);
  await page.goto("/launches");
  const lookup = page.getByLabel("Look up a token");
  await lookup.fill("not an address");
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByText("Enter a token address: 0x and 40 hexadecimal characters.")).toBeVisible();
  await expect(lookup).toHaveAttribute("aria-invalid", "true");

  await page.getByRole("navigation", { name: "Time window" }).getByRole("link", { name: "1 hour" }).click();
  await expect(page).toHaveURL(/window=1h/);
  const stats = page.getByRole("list", { name: "The last hour on Pons" });
  await expect(stats.getByRole("listitem").filter({ hasText: "Launches in the last hour" })).toContainText("5");
  await expect(page.getByRole("region", { name: "Newest launches" }).getByRole("listitem")).toHaveCount(5);

  await lookup.fill(GLINT.token);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page).toHaveURL(new RegExp(`/launches/${GLINT.token}$`));
  await expect(page.getByRole("heading", { name: "GLINT", level: 1 })).toBeVisible();
});

test("endpoints that refuse wide ranges or queries without an address are worked around", async ({ page }) => {
  const chain = await stubLaunchChain(page, {
    maxSpan: 10_001,
    spanMessage: (limit) => `eth_getLogs block range too large (max ${limit} blocks)`,
    needsAddress: true,
    maxAddresses: 10,
  });
  await page.goto("/launches");
  await expect(page.getByRole("region", { name: "Newest launches" }).getByRole("listitem")).toHaveCount(10);
  const movers = page.getByRole("region", { name: "Most traded in the last 15 minutes" });
  await expect(movers).toContainText("among the newest launches only");
  await expect(movers.getByRole("listitem").first()).toContainText("FIZZ");
  // Never a log query wider than the endpoint allows, after it said so once. Once per reader: in
  // development React runs the page's effect twice, so two readers start.
  const spans = chain.log
    .filter((entry) => entry.method === "eth_getLogs")
    .map((entry) => {
      const filter = entry.params[0] as { fromBlock: string; toBlock: string };
      return Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n);
    });
  expect(spans.length).toBeGreaterThan(20);
  expect(spans.filter((span) => span > 10_001).length).toBeLessThanOrEqual(2);
});

test("when the chain does not answer, the page says so and can try again", async ({ page }) => {
  await stubLaunchChain(page, { down: true });
  await page.goto("/launches");
  await expect(page.getByRole("alert")).toContainText("Robinhood Chain's public endpoints did not answer just now.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the footer and the list of products reach Launches", async ({ page }) => {
  await stubLaunchChain(page);
  await page.goto("/tools");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Launches" }).click();
  await expect(page).toHaveURL(/\/launches$/);
  await expect(page.getByRole("heading", { name: "Every Pons launch, read from the chain" })).toBeVisible();
});
