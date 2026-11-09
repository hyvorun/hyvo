/**
 * HYVO holder utilities: the watch button and /watchlist, /track, and the token page's list of what holding HYVO does.
 * The chain is the fictional Pons world of @hyvo/launches/testing (stub-launches.ts); the API is stubbed.
 */
import { DEMO_LAUNCHES, fakeAddress } from "@hyvo/launches/testing";
import { expect, test, type Page } from "@playwright/test";
import { stubApi } from "./stub-api";
import { stubLaunchChain } from "./stub-launches";

const API = "http://api.test";
const FIZZ = DEMO_LAUNCHES[0]!;
const MOTE = DEMO_LAUNCHES[3]!;
/** In the demo world FIZZ's trader 1 bought twice and MOTE's trader 2 sold. */
const BUYER = fakeAddress(`trader:${FIZZ.curve}:1`);
const SELLER = fakeAddress(`trader:${MOTE.curve}:2`);
const HOLDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A signed-in holder: a stored session, GET /v1/me saying eligible, and account lists kept in memory. */
async function signedInHolder(page: Page, lists: { watchlist: string[]; tracked: string[] }) {
  await page.addInitScript((address) => {
    localStorage.setItem("hyvo.session", JSON.stringify({ token: "t".repeat(43), address, expiresAt: "2100-01-01T00:00:00Z", admin: false }));
  }, HOLDER);
  const puts: { path: string; body: unknown }[] = [];
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, PUT" };
  await page.route(`${API}/v1/me`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({
        address: HOLDER,
        admin: false,
        holder: {
          enabled: true,
          eligible: true,
          minBalance: "1000000",
          balance: "2000000",
          balance24hAgo: "2000000",
          freeRunsPerMonth: 2,
          freeRunsLeft: 2,
          discountBps: 2000,
          freeRunMax: { agents: 50, rounds: 10 },
        },
      }),
    }),
  );
  await page.route(`${API}/v1/account/*`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const kind = new URL(request.url()).pathname.endsWith("/watchlist") ? "watchlist" : "tracked";
    const field = kind === "watchlist" ? "tokens" : "wallets";
    if (request.method() === "PUT") {
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, string[]>;
      puts.push({ path: kind, body });
      lists[kind] = body[field] ?? [];
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ [field]: lists[kind], updatedAt: "2026-11-10T00:00:00Z" }) });
  });
  return puts;
}

test("a launch saved with its watch button shows on the watchlist, read from the chain", async ({ page }) => {
  await stubLaunchChain(page);
  await stubApi(page);
  await page.goto(`/launches/${FIZZ.token}`);
  await expect(page.getByRole("heading", { name: "FIZZ", level: 1 })).toBeVisible();
  const watch = page.getByRole("button", { name: "Add to watchlist" });
  await expect(watch).toHaveAttribute("aria-pressed", "false");
  await watch.click();
  await expect(page.getByRole("button", { name: "On your watchlist" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("contentinfo").getByRole("link", { name: "Watchlist" }).click();
  await expect(page).toHaveURL(/\/watchlist$/);
  await expect(page.getByRole("heading", { name: "Watchlist", level: 1 })).toBeVisible();
  const saved = page.getByRole("list", { name: "Saved launches" });
  await expect(saved.getByRole("listitem")).toHaveCount(1);
  await expect(saved).toContainText("FIZZ");
  await expect(saved).toContainText("Paired with ETH");
  await expect(saved.getByRole("link")).toHaveAttribute("href", `/launches/${FIZZ.token}`);
  const provenance = page.getByText(/^Measured on-chain at block/);
  await expect(provenance).toContainText("109,867,700");
  await expect(provenance).toContainText("Not a trading signal.");
  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser" })).toBeVisible();
  await noHorizontalScroll(page);

  await saved.getByRole("button", { name: "Take FIZZ off the watchlist" }).click();
  await expect(page.getByRole("heading", { name: "Nothing saved yet" })).toBeVisible();
});

test("Track follows one wallet and lists its curve trades, each linked to its launch", async ({ page }) => {
  await stubLaunchChain(page);
  await stubApi(page);
  await page.goto("/track");
  await expect(page.getByRole("heading", { name: "Track wallets", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Following 0 of 1 wallet" })).toBeVisible();
  await expect(page.getByText("Follow a wallet above to see its trades here.")).toBeVisible();

  const input = page.getByLabel("Wallet address");
  await input.fill("0x1234");
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("0x followed by 40 hexadecimal characters");

  await input.fill(BUYER);
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Following 1 of 1 wallet" })).toBeVisible();
  const trades = page.getByRole("list", { name: "Trades" });
  await expect(trades.getByRole("listitem")).toHaveCount(2);
  await expect(trades.getByRole("listitem").first()).toContainText("bought");
  await expect(trades.getByRole("listitem").first()).toContainText(" ETH in, 1M FIZZ out");
  await expect(trades.getByRole("link", { name: "FIZZ" }).first()).toHaveAttribute("href", `/launches/${FIZZ.token}`);
  const provenance = page.getByText(/^Measured on-chain at block/);
  await expect(provenance).toContainText("109,867,700");
  await expect(provenance).toContainText("Not a trading signal.");
  await noHorizontalScroll(page);

  // A second wallet is for holders.
  await input.fill(SELLER);
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Everyone can follow 1 wallet. HYVO holders follow up to 25");
  await expect(page.getByRole("heading", { name: "Following 1 of 1 wallet" })).toBeVisible();

  await page.getByRole("button", { name: /^Stop following/ }).click();
  await expect(page.getByRole("heading", { name: "Following 0 of 1 wallet" })).toBeVisible();
});

test("a holder follows up to 25 wallets and keeps both lists with the account", async ({ page }) => {
  await stubLaunchChain(page);
  await stubApi(page);
  const lists = { watchlist: [MOTE.token.toLowerCase()], tracked: [BUYER.toLowerCase()] };
  const puts = await signedInHolder(page, lists);

  await page.goto("/track");
  await expect(page.getByRole("heading", { name: "Following 1 of 25 wallets" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Kept with your account" })).toBeVisible();
  await page.getByLabel("Wallet address").fill(SELLER);
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Following 2 of 25 wallets" })).toBeVisible();
  await expect.poll(() => puts.find((put) => put.path === "tracked")?.body).toEqual({ wallets: [BUYER.toLowerCase(), SELLER.toLowerCase()] });
  const trades = page.getByRole("list", { name: "Trades" });
  await expect(trades.getByRole("listitem").filter({ hasText: "sold" }).first()).toContainText("MOTE");
  await expect(trades.getByRole("listitem").filter({ hasText: "bought" }).first()).toContainText("FIZZ");

  // The watchlist kept with the account shows on this browser.
  await page.goto("/watchlist");
  await expect(page.getByRole("list", { name: "Saved launches" })).toContainText("MOTE");
  await expect(page.getByRole("status").filter({ hasText: "Kept with your account" })).toBeVisible();
});

test("the token page lists what holding HYVO does, the utilities included; Watchlist and Track are in the footer only", async ({ page }) => {
  await stubApi(page);
  await page.goto("/token");
  const holding = page.getByRole("region", { name: "What holding it does" });
  for (const name of ["Board live", "Watchlist sync", "25 tracked wallets"]) await expect(holding.getByText(name, { exact: true })).toBeVisible();
  await expect(holding).toContainText("every 10 seconds");
  await expect(holding.getByRole("link", { name: "Open it" })).toHaveCount(3);
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "Watchlist" })).toHaveAttribute("href", "/watchlist");
  await expect(footer.getByRole("link", { name: "Track" })).toHaveAttribute("href", "/track");
  await expect(page.getByRole("banner").getByRole("link", { name: "Watchlist" })).toHaveCount(0);
  await expect(page.getByRole("banner").getByRole("link", { name: "Track" })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/price|returns|payout/i);
});
