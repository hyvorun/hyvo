import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { chainState, injectWallet, stubChain } from "./stub-chain";
import { ADDRESSES, ORDER_ID, stubApi } from "./stub-api";

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function paymentsClosed(page: Page) {
  await page.route("http://api.test/v1/health", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      json: {
        ok: true,
        version: "test",
        features: { payments: false, oracle: true, holder: false, clone: false },
        limits: { minAgents: 10, maxAgents: 500, minRounds: 3, maxRounds: 30, maxDecisions: 840 },
      },
    }),
  );
}

test("the docs explain the API, MCP and verification, from the API's own address", async ({ page }) => {
  await stubApi(page);
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Docs", level: 1 })).toBeVisible();
  for (const name of ["Read runs", "Keys and balance", "Start a run", "MCP", "Verify a hash", "Webhooks", "Ask an agent"]) {
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "On this page" }).getByRole("link", { name })).toBeVisible();
  }
  await expect(page.getByText("http://api.test/mcp").first()).toBeVisible();
  for (const tool of ["create_run", "get_run", "ask_agent", "list_recent_runs", "verify_run"]) {
    await expect(page.getByText(tool, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Synthetic crowd reaction. Not a trading signal.")).toBeVisible();
  await expect(page.getByText("Top-ups are not open yet")).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("the docs say so when top-ups are closed", async ({ page }) => {
  await stubApi(page);
  await paymentsClosed(page);
  await page.goto("/docs");
  await expect(page.getByText("Top-ups are not open yet")).toBeVisible();
});

test("the page is reachable from the header", async ({ page }) => {
  await stubApi(page);
  await page.goto("/runs");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await noHorizontalScroll(page);
});

test("a wallet makes an API key that is shown once, and revokes it", async ({ page }) => {
  const api = await stubApi(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("This wallet has no keys yet.")).toBeVisible();

  await page.getByLabel("Name, for you").fill("my bot");
  await page.getByRole("button", { name: "Make a key" }).click();
  await expect(page.getByText("This is the only time this key is shown.")).toBeVisible();
  const shown = await page.locator("code").first().innerText();
  expect(shown).toMatch(/^hyvo_/);
  await expect(page.getByRole("button", { name: "Revoke my bot" })).toBeVisible();
  await noHorizontalScroll(page);

  // After a reload the key is gone for good; only its first characters remain.
  await page.reload();
  await expect(page.getByRole("button", { name: "Revoke my bot" })).toBeVisible();
  await expect(page.getByText(shown)).toHaveCount(0);

  await page.getByRole("button", { name: "Revoke my bot" }).click();
  await expect(page.getByText("This wallet has no keys yet.")).toBeVisible();
  expect(api.requests.some((request) => request.method === "DELETE" && request.path.startsWith("/v1/keys/"))).toBe(true);
});

test("a wallet tops up its balance, approving exactly the amount", async ({ page }) => {
  const api = await stubApi(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Balance" })).toBeVisible();
  await expect(page.getByText("$0.00")).toBeVisible();

  await page.getByLabel("Top up, in USD").fill("2");
  await page.getByRole("button", { name: "Pay with USDG" }).click();
  await expect(page.getByText("Top-up", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("$2.00").first()).toBeVisible();

  expect(state.sent).toHaveLength(2);
  const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
  const router = parseAbi(["function pay(bytes32 orderId, address token, uint256 amount)"]);
  const approve = decodeFunctionData({ abi: erc20, data: state.sent[0]!.data as `0x${string}` });
  expect(approve.args).toEqual([getAddress(ADDRESSES.router), 2_000_000n]);
  const pay = decodeFunctionData({ abi: router, data: state.sent[1]!.data as `0x${string}` });
  expect(pay.args).toEqual([ORDER_ID, getAddress(ADDRESSES.usdg), 2_000_000n]);
  expect(api.requests.find((request) => request.path === "/v1/balance/topups")?.body).toEqual({ amountUsd: 2 });
});

test("a wallet without enough USDG is told before any transaction", async ({ page }) => {
  await stubApi(page);
  const state = chainState({ balance: 100n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Top up, in USD").fill("2");
  await page.getByRole("button", { name: "Pay with USDG" }).click();
  await expect(page.getByRole("alert")).toContainText("this top-up costs 2.00 USDG");
  expect(state.sent).toHaveLength(0);
});

test("before payments open, the account page keeps keys but offers no top-up", async ({ page }) => {
  await stubApi(page);
  await paymentsClosed(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Top-ups are not open yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay with USDG" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make a key" })).toBeVisible();
});
