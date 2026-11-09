import { expect, test, type Page } from "@playwright/test";
import { golden, stubApi } from "./stub-api";

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the header reaches the free tools, and the hub lists every one", async ({ page }) => {
  await stubApi(page);
  await page.goto("/runs");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tools" }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await expect(page.getByRole("heading", { name: "Free tools", level: 1 })).toBeVisible();
  for (const name of ["Swap and price impact", "Impermanent loss", "Market cap and supply", "Units", "Checklists", "Glossary", "Which trader are you?"]) {
    await expect(page.getByRole("link", { name: new RegExp(name.replace("?", "\\?")) }).first()).toBeVisible();
  }
  await noHorizontalScroll(page);
});

test("the swap calculator works a trade out and keeps it in the address", async ({ page }) => {
  // 10 ETH against 1M tokens, no fee: 1 ETH in brings 1,000,000 × 1 / 11 tokens out.
  await page.goto("/tools/swap?eth=10&tokens=1m&fee=0&amount=1");
  await expect(page.getByText("90,909.1 tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("+21.0%").first()).toBeVisible();
  await page.getByRole("radio", { name: "Tokens in, ETH out" }).click();
  await page.getByLabel("Tokens you put in").fill("100k");
  await expect(page.getByText("0.909091 ETH", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/side=tokens/);
  await expect(page).toHaveURL(/amount=100k/);
  await page.getByLabel("ETH in the pool").fill("lots");
  await expect(page.getByText("Enter the ETH in the pool, such as 5.")).toBeVisible();
  await expect(page.getByText(/Arithmetic only: it is not advice/)).toBeVisible();
  await noHorizontalScroll(page);
});

test("the other calculators answer from what is typed", async ({ page }) => {
  await page.goto("/tools/impermanent-loss?move=300");
  await expect(page.getByText("−20.0%").first()).toBeVisible();
  await noHorizontalScroll(page);

  await page.goto("/tools/market-cap?price=0.5&supply=10m&held=100k");
  // Market cap and fully diluted value agree when every token circulates.
  await expect(page.getByText("5,000,000", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("50,000", { exact: true })).toBeVisible();
  await noHorizontalScroll(page);

  await page.goto("/tools/units");
  await page.getByRole("textbox", { name: "Gwei", exact: true }).fill("2.5");
  await expect(page.getByRole("textbox", { name: "Wei", exact: true })).toHaveValue("2500000000");
  await expect(page.getByRole("textbox", { name: "ETH", exact: true })).toHaveValue("0.0000000025");
  await noHorizontalScroll(page);
});

test("the trader quiz ends on an archetype with a link to share", async ({ page }) => {
  await page.goto("/tools/quiz");
  await expect(page.getByText("Question 1 of 10")).toBeVisible();
  // The first answer each time: two each for the sniper, the holder and the panic seller, and the
  // panic seller was picked last of the three.
  for (let question = 0; question < 10; question++) {
    await page.locator("ul button").first().click();
  }
  await expect(page.getByText("You trade like a")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Panic seller", level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/result=panic_seller/);
  await expect(page.getByText("Just for fun. The archetypes describe behavior, and none of this is advice.")).toBeVisible();
  await noHorizontalScroll(page);

  await page.goto("/tools/quiz?result=whale");
  await expect(page.getByText("Someone trades like a")).toBeVisible();
  await page.getByRole("button", { name: "Take the quiz" }).click();
  await expect(page.getByText("Question 1 of 10")).toBeVisible();
});

test("the checklists keep their ticks in the browser", async ({ page }) => {
  await page.goto("/tools/checklist");
  await page.getByRole("checkbox").first().check();
  await expect(page.getByText("1 of 11 done")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox").first()).toBeChecked();
  await page.getByRole("radio", { name: "Trading a new token" }).click();
  await expect(page.getByRole("heading", { name: "Before you trade a new token" })).toBeVisible();
  await expect(page.getByText(/no list makes a token safe/)).toBeVisible();
  await noHorizontalScroll(page);
});

test("the glossary filters, and a link lands on its term", async ({ page }) => {
  await page.goto("/tools/glossary");
  await page.getByLabel("Find a term").fill("honeypot");
  await expect(page.getByText(/^1 of \d+ terms$/)).toBeVisible();
  await page.goto("/tools/glossary#impermanent-loss");
  await expect(page.locator("#impermanent-loss")).toBeInViewport();
  await noHorizontalScroll(page);
});

test("the trust page says what Hyvo never does, and the token page what the token is for", async ({ page }) => {
  await page.goto("/trust");
  await expect(page.getByRole("heading", { name: "Official accounts" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "@Hyvorun" })).toHaveAttribute("href", "https://x.com/Hyvorun");
  await expect(page.getByRole("heading", { name: "Hyvo never…" })).toBeVisible();
  for (const never of ["Keeps your money in a contract", "Moves or approves your tokens", "Changes a published run", "Gives trading advice"]) {
    await expect(page.getByRole("heading", { name: never, level: 3 })).toBeVisible();
  }
  // The test build pins no contract addresses, so nothing is read from the chain.
  await expect(page.getByText("This build of the site does not list the contract addresses")).toBeVisible();
  await expect(page.getByText("Synthetic crowd reaction. Not a trading signal.")).toBeVisible();
  // It has no HYVO address either: before the launch, no token is Hyvo's (e2e/token-live.spec.ts has the after).
  await expect(page.getByRole("main").getByText(/^Hyvo has not launched a token yet: until \/token shows an address/)).toBeVisible();
  await expect(page.getByRole("main").getByText(/^Token:/)).toHaveCount(0);
  await noHorizontalScroll(page);

  await page.goto("/token");
  await expect(page.getByRole("heading", { name: "Coming soon" })).toBeVisible();
  await expect(page.getByText(/^Hyvo has not launched a token yet, so no token named HYVO is Hyvo.s today\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the address" })).toHaveCount(0);
  await expect(page.getByText("2 free runs")).toBeVisible();
  await expect(page.getByText("For a wallet that holds at least 1,000,000 HYVO, now and 24 hours earlier.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Planned for holders" })).toBeVisible();
  // Only what the token is for: nothing about fees, payouts or where money goes.
  await expect(page.locator("main")).not.toContainText(/yield|revenue|creator|Pons/i);
  await noHorizontalScroll(page);
});

test("a run says how it was made, with a link to its exact file", async ({ page }) => {
  await stubApi(page);
  await page.goto(`/run/${golden.runId}`);
  await page.getByText("How this run was made").click();
  await expect(page.getByText("Written by whoever asked for the run")).toBeVisible();
  await expect(page.getByText(/51 model calls/)).toBeVisible();
  await expect(page.getByText("Nothing was taken out or rewritten.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the exact run.json" })).toHaveAttribute("href", /run\.json/);
  await noHorizontalScroll(page);
});

test("an example fills the new run form with a fictional token", async ({ page }) => {
  await stubApi(page);
  await page.goto("/new");
  await page.getByRole("button", { name: "Creator tax" }).click();
  await expect(page.getByLabel("Title")).toHaveValue(/fictional token FIZZ/i);
  await expect(page.getByText(/Filled in: FIZZ/)).toBeVisible();
  await page.getByRole("button", { name: "Thin liquidity" }).click();
  await expect(page.getByLabel("Title")).toHaveValue(/DRIP/);
  await noHorizontalScroll(page);
});
