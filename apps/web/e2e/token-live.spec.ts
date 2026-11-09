import { expect, test, type Page } from "@playwright/test";
import { stubApi } from "./stub-api";

/*
 * The site once HYVO has launched. Runs with playwright.token.config.ts, which builds the site with a
 * test address; under any other config these tests skip themselves, since that build has no token.
 */

const API = "http://api.test";
const ONLY_TOKEN = "This is Hyvo's only token. A token at any other address is not Hyvo's, whatever its name.";
const RULE = "Hold at least 1,000,000 HYVO in one wallet, now and 24 hours earlier.";
/** What the token pages never speak of, or point to: where to trade it, prices, fees, tax, payouts, ratings. */
const NEVER = /\bbuy\b|\bsell\b|\bprice\b|\bfees?\b|\btax\b|payout|yield|revenue|Pons|\bsafe\b|scam|\brug\b|honeypot|legit|Draft numbers/i;

const HEALTH = {
  ok: true,
  version: "test",
  features: { payments: true, oracle: true, holder: true, clone: true },
  limits: { minAgents: 10, maxAgents: 500, minRounds: 3, maxRounds: 30, maxDecisions: 840 },
};
const TERMS = { min: "1000000", decimals: 18, heldForSeconds: 86_400 };

/** The address the build was made with (playwright.token.config.ts). */
function token(): string {
  return test.info().config.metadata.hyvoToken as string;
}

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.config.metadata.hyvoToken, "needs the build with a HYVO address: playwright.token.config.ts");
  await stubApi(page);
});

/** GET /v1/health with these holder terms (`undefined`: the field left out), over stub-api's answer. */
async function stubHealth(page: Page, holder: unknown, until?: Promise<void>) {
  await page.route(`${API}/v1/health`, async (route) => {
    await until;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(holder === undefined ? HEALTH : { ...HEALTH, holder }),
    });
  });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("/token shows the official address, a copy button, Hyvo's pages for it and who counts as a holder", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stubHealth(page, TERMS);
  await page.goto("/token");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "The HYVO token", level: 1 })).toBeVisible();
  await expect(main.getByText("HYVO is live on Robinhood Chain.", { exact: false })).toBeVisible();

  const status = main.getByRole("region", { name: "The official address" });
  await expect(status.getByText(token(), { exact: true })).toBeVisible();
  const size = await status.getByText(token(), { exact: true }).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(size).toBeGreaterThanOrEqual(17);
  await expect(status.getByRole("link", { name: "On Blockscout" })).toHaveAttribute("href", `https://robinhoodchain.blockscout.com/address/${token()}`);
  await expect(status.getByRole("link", { name: "In Hyvo Check" })).toHaveAttribute("href", `/check/${token()}`);
  await expect(status.getByRole("link", { name: "In Hyvo Launches" })).toHaveAttribute("href", `/launches/${token()}`);
  await expect(status.getByText(ONLY_TOKEN)).toBeVisible();

  const copy = status.getByRole("button", { name: "Copy the address" });
  const width = (await copy.boundingBox())!.width;
  await copy.click();
  await expect(status.getByRole("button", { name: "Copied" })).toBeVisible();
  expect((await status.getByRole("button", { name: "Copied" }).boundingBox())!.width).toBeCloseTo(width, 0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token());
  await expect(status.getByRole("button", { name: "Copy the address" })).toBeVisible({ timeout: 4_000 });

  const holding = main.getByRole("region", { name: "What holding it does" });
  await expect(holding.getByRole("listitem")).toHaveCount(6);
  await expect(holding.getByText("2 free runs")).toBeVisible();
  await expect(holding.getByRole("heading", { name: "Who counts as a holder" })).toBeVisible();
  await expect(holding.getByText(RULE)).toBeVisible();

  await expect(main.getByText("Coming soon")).toHaveCount(0);
  await expect(main.getByText(/has not launched a token yet/)).toHaveCount(0);
  await expect(main).not.toContainText(NEVER);
  await noHorizontalScroll(page);
});

test("the holder rule takes its room before the API answers, so nothing below it moves", async ({ page }) => {
  for (const [holder, sentence] of [
    [TERMS, RULE],
    [null, "How much to hold, and for how long, is set at the launch."],
  ] as const) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    await stubApi(page);
    await stubHealth(page, holder, answered);
    await page.goto("/token");
    const note = page.getByText(/^Sign in with the wallet that holds it/);
    await expect(note).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const before = (await note.boundingBox())!;
    answer();
    await expect(page.getByText(sentence, { exact: true })).toBeVisible();
    const after = (await note.boundingBox())!;
    expect(after.y).toBe(before.y);
  }
});

test("without holder terms from the API, the rule says it is set at the launch", async ({ page }) => {
  for (const holder of [undefined, null, { min: "0", decimals: 18, heldForSeconds: 86_400 }]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stubApi(page);
    await stubHealth(page, holder);
    await page.goto("/token");
    await expect(page.getByText(/^How much to hold, and for how long, is set at the launch\.$/)).toBeVisible();
    await expect(page.getByText(/^Hold at least/)).toHaveCount(0);
  }
  // An API that cannot be reached says nothing either.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route(`${API}/**`, (route) => route.abort());
  await page.goto("/token");
  await expect(page.getByText(/is set at the launch\.$/)).toBeVisible();
});

test("the home page says HYVO is live, with its one address, in the token section and the questions", async ({ page }) => {
  await page.goto("/");
  const section = page.getByRole("region", { name: "The HYVO token" });
  await expect(section.getByText("HYVO is live. Holding it brings free runs", { exact: false })).toBeVisible();
  await expect(section.getByRole("listitem")).toHaveCount(3);
  const card = section.getByRole("link", { name: /^The official address/ });
  await expect(card).toHaveAttribute("href", "/token");
  await expect(card.getByText(token(), { exact: true })).toBeVisible();
  await expect(card.getByText(ONLY_TOKEN)).toBeVisible();
  await expect(section.getByRole("link", { name: "What the token is for" })).toHaveAttribute("href", "/token");
  await expect(section).not.toContainText(NEVER);

  const questions = page.getByRole("region", { name: "Questions" });
  await questions.getByText("Is there a token?").click();
  const answer = questions.getByText(/^Yes: HYVO, at/);
  await expect(answer).toBeVisible();
  await expect(answer).toContainText(token());
  await expect(answer).toContainText(ONLY_TOKEN);
  await expect(answer).not.toContainText(NEVER);
  await noHorizontalScroll(page);
});

test("/trust lists the token next to the site and the X account", async ({ page }) => {
  await page.goto("/trust");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Official accounts" })).toBeVisible();
  await expect(main.getByRole("link", { name: "hyvo.run" })).toHaveAttribute("href", "https://hyvo.run");
  await expect(main.getByRole("link", { name: "@Hyvorun" })).toHaveAttribute("href", "https://x.com/Hyvorun");
  await expect(main.getByText(`Token: ${token()}`, { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: token() })).toHaveAttribute("href", `https://robinhoodchain.blockscout.com/address/${token()}`);
  await expect(main.getByText(ONLY_TOKEN, { exact: false })).toBeVisible();
  await expect(main.getByText(/has not launched a token yet/)).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("the header shows HYVO's address beside the X link, and one press copies it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stubApi(page);
  await page.goto("/");
  const ca = page.locator("header").getByRole("button", { name: `Copy HYVO's address, ${token()}` });
  await expect(ca).toBeVisible();
  await expect(ca).toHaveAttribute("title", token());
  // The address sits just before the X link.
  const x = page.locator("header").getByRole("link", { name: /Hyvo on X/ });
  expect((await ca.boundingBox())!.x).toBeLessThan((await x.boundingBox())!.x);
  await ca.click();
  await expect(page.locator("header").getByRole("status")).toHaveText("Copied HYVO's address");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token());
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

for (const width of [1440, 1180, 1024, 1000, 999, 860, 720, 700, 641, 390]) {
  test(`the header with HYVO's address fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await stubApi(page);
    await page.goto("/");
    await expect(page.locator("header").getByRole("button", { name: /Copy HYVO's address/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}
