import { expect, test, type Page } from "@playwright/test";
import { stubApi } from "./stub-api";
import { LOOKALIKE, NVDA, stockChain, stubStocks } from "./stub-stocks";

/** A page that reads the chain loads viem first; under a cold dev server that can take a while. */
const READ = { timeout: 15_000 };

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test("the list finds a token by ticker, and its page answers from the chain", async ({ page }) => {
  await stubStocks(page, stockChain());
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Stocks" }).click();
  await expect(page).toHaveURL(/\/stocks$/);
  await expect(page.getByRole("heading", { name: "Stocks", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "212 stock tokens" })).toBeVisible();
  await expect(page.getByText(/Read live at block 109,900,000: the factory has deployed nothing since\./)).toBeVisible(READ);
  const list = page.getByRole("region", { name: "212 stock tokens" }).getByRole("list");
  await expect(list.getByRole("listitem")).toHaveCount(24);
  await noHorizontalScroll(page);

  const box = page.getByLabel("Ticker or contract address");
  await box.fill("nvid");
  await expect(page.getByRole("heading", { name: "1 of 212 stock tokens" })).toBeVisible();
  await box.fill("nvda");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/stocks\/NVDA$/);

  await expect(page.getByRole("heading", { name: "NVDA", level: 1 })).toBeVisible();
  const verdict = page.getByRole("region", { name: "Is this the NVDA stock token?" });
  await expect(verdict.getByRole("heading", { name: "Yes. The Stock Token factory records this contract as NVDA." })).toBeVisible(READ);
  const price = page.getByRole("region", { name: "What its price is" });
  await expect(price.getByText("176.37")).toBeVisible();
  await expect(price.getByText("176.23 USD")).toBeVisible();
  await expect(price.getByText(/10 min ago/)).toBeVisible();
  const multiplier = page.getByRole("region", { name: "Multiplier", exact: true });
  await expect(multiplier.getByText("1.000775", { exact: true })).toBeVisible();
  await expect(multiplier.getByText("No change is scheduled.")).toBeVisible();
  const movement = page.getByRole("region", { name: "Can it move right now?" });
  await expect(movement.getByText("Open", { exact: true })).toBeVisible();
  await expect(movement.getByText(/Mon 10:00 in New York: Regular trading/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Multiplier changes" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByText("Measured on-chain at block 109,900,000. Not a trading signal.")).toBeVisible();
  await noHorizontalScroll(page);
});

test("a contract that copies a token's uid is not the token, and gets no price", async ({ page }) => {
  await stubStocks(page, stockChain());
  await page.goto(`/stocks/${LOOKALIKE}`);
  await expect(page.getByRole("heading", { name: /^Contract 0x0000/, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No. The factory records a different contract for this uid." })).toBeVisible(READ);
  await expect(page.getByText("It is not a judgment of what the contract does.", { exact: false })).toBeVisible();
  await expect(page.getByRole("region", { name: "What its price is" })).toHaveCount(0);
  await page.getByRole("link", { name: /^0xd060/ }).click();
  await expect(page).toHaveURL(new RegExp(`/stocks/${NVDA}$`));
  await expect(page.getByRole("heading", { name: "NVDA", level: 1 })).toBeVisible();
});

test("an empty address, an unknown ticker and a mistyped address each say what they are", async ({ page }) => {
  await stubStocks(page, stockChain());
  await page.goto("/stocks/0x000000000000000000000000000000000000dead");
  // A lowercase address gets its checksum in the address bar.
  await expect(page).toHaveURL(/\/stocks\/0x000000000000000000000000000000000000dEaD$/);
  await expect(page.getByRole("heading", { name: "No contract is deployed at this address." })).toBeVisible(READ);

  await page.goto("/stocks/zzzz");
  await expect(page).toHaveURL(/\/stocks\/ZZZZ$/);
  await expect(page.getByRole("heading", { name: "No stock token with the ticker ZZZZ", level: 1 })).toBeVisible();

  await page.goto("/stocks");
  const box = page.getByLabel("Ticker or contract address");
  await box.fill("0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
  await box.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(/do not match its checksum/);
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/stocks$/);
});

test("a paused token and a held feed say so, and the price is not divided", async ({ page }) => {
  await stubStocks(
    page,
    stockChain((chain) => {
      const nvda = chain.tokens.get(NVDA.toLowerCase())!;
      nvda.paused = true;
      nvda.tokenPaused = true;
      nvda.oraclePaused = true;
      // A 10:1 split staged for an hour from now.
      nvda.newUIMultiplier = 10_007_751_591_646_305_950n;
      nvda.effectiveAt = BigInt(1_794_236_400 + 3600);
    }),
  );
  await page.goto("/stocks/NVDA");
  const movement = page.getByRole("region", { name: "Can it move right now?" });
  await expect(movement.getByText("Paused", { exact: true }).first()).toBeVisible(READ);
  await expect(movement.getByText(/transfers, approvals, mints and burns revert/)).toBeVisible();
  await expect(movement.getByText(/Chainlink's feed holds its last value/)).toBeVisible();
  const multiplier = page.getByRole("region", { name: "Multiplier", exact: true });
  await expect(multiplier.getByText(/Becomes 10\.00775159164630595 on 9 Nov 2026, 16:00 UTC \(in 60 min\)/)).toBeVisible();
  await expect(page.getByRole("region", { name: "What its price is" }).getByText(/the oracle is paused/)).toBeVisible();
});

test("the whole list opens on request, and focus lands on the first new row", async ({ page }) => {
  await stubStocks(page, stockChain());
  await page.goto("/stocks");
  await page.getByRole("button", { name: "Show all 212" }).click();
  const list = page.getByRole("region", { name: "212 stock tokens" }).getByRole("list");
  await expect(list.getByRole("listitem")).toHaveCount(212);
  await expect(list.getByRole("link").nth(24)).toBeFocused();
  await noHorizontalScroll(page);
});

test("the home page lists Stocks among Hyvo's products", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("region", { name: "What you can do with Hyvo" }).getByRole("listitem").filter({ hasText: "Stocks" });
  await expect(row.getByRole("link", { name: "Stocks" })).toHaveAttribute("href", "/stocks");
  await expect(row).toContainText("Live");
});
