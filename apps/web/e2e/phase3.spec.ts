import { DISCLAIMER, scenarioHash } from "@hyvo/schema";
import { expect, test } from "@playwright/test";
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { chainState, injectWallet, stubChain, wallet } from "./stub-chain";
import { ADDRESSES, golden, NEW_RUN_ID, ORDER_ID, quotedOrder, RUNNING_ID, runningStatus, stubApi } from "./stub-api";

async function noHorizontalScroll(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("the oracle page verifies a run against the chain in the browser", async ({ page }) => {
  await stubApi(page);
  await stubChain(page, chainState({ commit: { reportHash: golden.hash as `0x${string}`, scenarioHash: scenarioHash(golden.scenario) } }));
  await page.goto("/oracle");
  await expect(page.getByRole("heading", { name: "Oracle ledger" })).toBeVisible();
  await expect(page.getByRole("link", { name: golden.scenario.title })).toBeVisible();
  await page.getByRole("listitem").filter({ hasText: golden.runId }).getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /^Verified/ })).toBeVisible();
  await expect(page.getByText("passed", { exact: true })).toHaveCount(3);
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`run=${golden.runId}`));
  // This test build has no pinned address, and the page says where its address came from.
  await expect(page.getByText("as reported by the Hyvo API")).toBeVisible();
  await noHorizontalScroll(page);
});

test("a commit with another hash does not verify", async ({ page }) => {
  await stubApi(page);
  await stubChain(page, chainState({ commit: { reportHash: `0x${"11".repeat(32)}`, scenarioHash: scenarioHash(golden.scenario) } }));
  await page.goto(`/oracle?run=${golden.runId}`);
  await expect(page.getByRole("heading", { name: "Not verified" })).toBeVisible();
  await expect(page.getByText("failed", { exact: true })).toHaveCount(1);
});

test("the replay shows the on-chain commit", async ({ page }) => {
  await stubApi(page);
  await page.goto(`/run/${golden.runId}`);
  await expect(page.getByText("Hash committed on Robinhood Chain")).toBeVisible();
  await expect(page.getByRole("link", { name: "Verify" })).toHaveAttribute("href", `/oracle?run=${golden.runId}`);
});

test("a run that is still playing shows its progress", async ({ page }) => {
  await stubApi(page);
  await page.goto(`/run/${RUNNING_ID}`);
  await expect(page.getByRole("heading", { name: "The crowd is playing your scenario" })).toBeVisible();
  await expect(page.getByText("Round 4 of 10.")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
});

test("a run page on screen survives a failed poll", async ({ page }) => {
  await stubApi(page);
  let mode: "normal" | "fail" | "next" = "normal";
  const headers = { "Access-Control-Allow-Origin": "*" };
  await page.route(`http://api.test/v1/runs/${RUNNING_ID}`, async (route) => {
    if (mode === "fail") {
      mode = "next";
      return route.fulfill({ status: 500, headers, body: "{}" });
    }
    if (mode === "next") return route.fulfill({ status: 200, headers, json: runningStatus(5) });
    return route.fallback();
  });
  await page.goto(`/run/${RUNNING_ID}`);
  await expect(page.getByText("Round 4 of 10.")).toBeVisible();
  mode = "fail";
  await expect(page.getByText("Round 5 of 10.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("changing the form after a quote asks for a new price", async ({ page }) => {
  await stubApi(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByRole("button", { name: "Pay 1.00 USDG" })).toBeVisible();
  await page.getByLabel("Title").fill("Fictional token FIZZ lists again");
  await expect(page.getByRole("button", { name: "Pay 1.00 USDG" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get a price" })).toBeVisible();
});

test("a price for another wallet cannot be paid from this one", async ({ page }) => {
  await stubApi(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.route("http://api.test/v1/quotes", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fallback()
      : route.fulfill({
          status: 201,
          headers: { "Access-Control-Allow-Origin": "*" },
          json: { order: quotedOrder("0x70997970C51812dc3A010C7d01b50e0d17dc79C8") },
        }),
  );
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByRole("button", { name: "Get a price" }).click();
  await page.getByRole("button", { name: "Pay 1.00 USDG" }).click();
  await expect(page.getByRole("alert")).toContainText("This price is for wallet");
  expect(state.sent).toHaveLength(0);
});

test("the form explains what is missing before asking for a wallet", async ({ page }) => {
  await stubApi(page);
  await page.goto("/new");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("Give the scenario a title.")).toBeVisible();
  await expect(page.getByText(/anyone with the run id can open them/)).toBeVisible();
  await expect(page.getByLabel("Title")).toBeFocused();
  // The crowd preview follows the size.
  await page.getByRole("radio", { name: /Large/ }).click();
  await expect(page.getByText("800", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Agents" }).fill("5");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("Choose 10 to 2,000 agents.")).toBeVisible();
  await noHorizontalScroll(page);
});

test("a run over the limit is explained before any wallet", async ({ page }) => {
  await stubApi(page);
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByRole("textbox", { name: "Agents" }).fill("100");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText(/Runs are limited to 840 decisions/)).toBeVisible();
});

test("before paid runs open, the page says so instead of asking for a wallet", async ({ page }) => {
  await stubApi(page);
  await page.route("http://api.test/v1/health", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      json: {
        ok: true,
        version: "test",
        features: { payments: false, oracle: false, holder: false, clone: false },
        limits: { minAgents: 10, maxAgents: 500, minRounds: 3, maxRounds: 30, maxDecisions: 840 },
      },
    }),
  );
  await page.goto("/new");
  await expect(page.getByText("Paid runs are not open yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get a price" })).toHaveCount(0);
});

test("without a browser wallet the page says what to do", async ({ page }) => {
  await stubApi(page);
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByRole("alert")).toContainText("No browser wallet was found");
});

test("a wallet signs in, gets a price, approves exactly the amount and pays", async ({ page }) => {
  const api = await stubApi(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("$1.00")).toBeVisible();
  await expect(page.getByText(/^Signed in as/)).toBeVisible();

  await page.getByRole("button", { name: "Pay 1.00 USDG" }).click();
  await expect(page).toHaveURL(new RegExp(`/run/${NEW_RUN_ID}$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Your run is in the queue" })).toBeVisible();

  // Two transactions: approve exactly the price for the router, then pay that order.
  expect(state.sent).toHaveLength(2);
  const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
  const router = parseAbi(["function pay(bytes32 orderId, address token, uint256 amount)"]);
  const approve = decodeFunctionData({ abi: erc20, data: state.sent[0]!.data as `0x${string}` });
  expect(state.sent[0]!.to.toLowerCase()).toBe(ADDRESSES.usdg.toLowerCase());
  expect(approve.args).toEqual([getAddress(ADDRESSES.router), 1_000_000n]);
  const pay = decodeFunctionData({ abi: router, data: state.sent[1]!.data as `0x${string}` });
  expect(state.sent[1]!.to.toLowerCase()).toBe(ADDRESSES.router.toLowerCase());
  expect(pay.args).toEqual([ORDER_ID, getAddress(ADDRESSES.usdg), 1_000_000n]);

  // The API saw a signed-in quote and the payment's transaction hash.
  const quote = api.requests.find((r) => r.path === "/v1/quotes")!;
  expect(quote.auth).toMatch(/^Bearer /);
  expect(quote.body).toMatchObject({ scenario: { title: "Fictional token FIZZ lists" }, agents: 50, rounds: 10, listed: true });
  const signIn = api.requests.find((r) => r.path === "/v1/auth/siwe/verify")!;
  expect(String((signIn.body as { message: string }).message)).toContain(wallet.address);
  expect(String((signIn.body as { message: string }).message)).toContain("Chain ID: 4663");
  expect(api.requests.some((r) => r.path === `/v1/orders/${ORDER_ID}/payment`)).toBe(true);
});

test("a wallet without enough USDG is told before any transaction", async ({ page }) => {
  await stubApi(page);
  const state = chainState({ balance: 500_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByRole("button", { name: "Get a price" }).click();
  await page.getByRole("button", { name: "Pay 1.00 USDG" }).click();
  await expect(page.getByRole("alert")).toContainText("This wallet holds 0.50 USDG; the run costs 1.00 USDG.");
  expect(state.sent).toHaveLength(0);
});
