import { expect, test, type Page } from "@playwright/test";
import { stubApi } from "./stub-api";
import { BLOCK, OWNER, SELL_REVERTS, TAXED, TOKEN, stubCheck } from "./stub-check";
import { CREATION_TX, FACTS, SOURCE, stubHolders } from "./stub-holders";

const MINUS = "−";

// Hyvo's API, which the page asks for the top holders, answers nothing unless a test says otherwise.
test.beforeEach(async ({ page }) => {
  await stubHolders(page, "fail");
});

/** Nothing wider than the screen: on a phone, a page that overflows widens the layout viewport instead. */
async function fitsTheScreen(page: Page) {
  const width = page.viewportSize()!.width;
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(inner).toBe(width);
  expect(scroll).toBeLessThanOrEqual(width);
}

/** Opens a /check page. The first visit to a cold dev server compiles the page and @hyvo/check, so it may take a while. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Hyvo Check", level: 1 })).toBeVisible({ timeout: 30_000 });
}

function step(page: Page, title: string) {
  return page
    .getByRole("region", { name: "Buy, send, sell back" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

function finding(page: Page, title: string) {
  return page
    .getByRole("region", { name: "Every check, with its evidence" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

test("a taxed token: every step arrives short of its promise, and the page says by how much", async ({ page }) => {
  const log = await stubCheck(page, { probe: TAXED, sourcify: "verified" });
  await open(page, "/check");

  // From the keyboard: an address in lower case, and Enter.
  const field = page.getByLabel("Token address");
  await field.fill(TOKEN.toLowerCase());
  await field.press("Enter");
  await expect(page).toHaveURL(`/check/${TOKEN}`);
  await expect(page.getByRole("heading", { name: "TAX Taxed Token", level: 2 })).toBeVisible();
  await expect(page.getByText(`Check finished: TAX at block ${BLOCK}.`)).toBeAttached();

  const buy = step(page, "Buy");
  await expect(buy).toContainText("306,170 TAX");
  await expect(buy).toContainText("290,861.5 TAX");
  await expect(buy).toContainText(`${MINUS}5%`);
  await expect(buy).toContainText("5% less than promised");
  const send = step(page, "Send to another wallet");
  await expect(send).toContainText("29,086.15 TAX");
  await expect(send).toContainText("27,631.84 TAX");
  await expect(send).toContainText("5% less than sent");
  const sell = step(page, "Sell back");
  await expect(sell).toContainText("0.00085 ETH");
  await expect(sell).toContainText("0.0008075 ETH");
  await expect(sell).toContainText("5% less than promised");

  const exit = page.getByRole("region", { name: "Buy, send, sell back" });
  await expect(exit.getByText("10.28%")).toBeVisible();
  await expect(exit).toContainText("The part that was sold cost 0.0009 ETH at the buy's average price, and 0.0008075 ETH came back.");
  await expect(exit).toContainText("Uniswap V2 pair with WETH");

  await expect(page.getByRole("region", { name: "Every check, with its evidence" }).getByRole("listitem")).toHaveCount(11);
  await expect(finding(page, "Sell or transfer shortfall")).toContainText("Found");
  await expect(finding(page, "Sell or transfer shortfall")).toContainText("5% short of the router's quote");
  await expect(finding(page, "Fee or tax setter")).toContainText("setTaxes(uint256,uint256)");
  // Hyvo's API did not answer: the holders stay skipped, and say why.
  await expect(finding(page, "Top holders")).toContainText("Skipped");
  await expect(finding(page, "Top holders")).toContainText("Hyvo's API did not answer with the token's holders from Blockscout's index.");

  await expect(page.getByRole("heading", { name: "What this check cannot tell" })).toBeVisible();
  await expect(page.getByText(`Measured on-chain at block ${BLOCK}. Not a trading signal.`)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/\b(safe|scam|rug|honeypot|legit)\b/i);
  await fitsTheScreen(page);

  // Read-only: reads and calls, never a transaction.
  expect(log.rpc.every((method) => ["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getStorageAt", "eth_call"].includes(method))).toBe(true);
  expect(log.sourcify).toBeGreaterThan(0);

  // Checking again reads the chain again and keeps the report on screen.
  const before = log.rpc.length;
  await page.getByRole("button", { name: "Check again at the latest block" }).click();
  await expect.poll(() => log.rpc.length).toBeGreaterThan(before);
  await expect(page.getByRole("button", { name: "Check again at the latest block" })).toBeEnabled();
  await expect(buy).toContainText("290,861.5 TAX");
});

test("a sell that reverts: the reason from the chain, and no round trip", async ({ page }) => {
  await stubCheck(page, { probe: SELL_REVERTS, name: "Locked Token", symbol: "LOCK" });
  await open(page, `/check/${TOKEN}`);
  await expect(page.getByRole("heading", { name: "LOCK Locked Token", level: 2 })).toBeVisible();

  await expect(step(page, "Buy")).toContainText("as promised");
  await expect(step(page, "Send to another wallet")).toContainText("in full");
  const sell = step(page, "Sell back");
  await expect(sell).toContainText("Reverted");
  await expect(sell).toContainText('Error("TransferHelper: TRANSFER_FROM_FAILED")');
  await expect(sell).toContainText("0.000894 ETH");
  await expect(sell).not.toContainText("Difference");
  await expect(page.getByRole("region", { name: "Buy, send, sell back" })).toContainText("No round trip: the sell did not go through.");

  await expect(finding(page, "Sell or transfer shortfall")).toContainText("Found");
  await expect(finding(page, "Sell or transfer shortfall")).toContainText('the sell reverted with Error("TransferHelper: TRANSFER_FROM_FAILED")');
  await fitsTheScreen(page);
});

test("a token with no venue: no simulation, and the reason", async ({ page }) => {
  await stubCheck(page, { venue: "none", name: "Quiet Token", symbol: "QT" });
  await open(page, `/check/${TOKEN.toLowerCase()}`);
  // One link per token: the address is put in its checksummed form.
  await expect(page).toHaveURL(`/check/${TOKEN}`);

  const exit = page.getByRole("region", { name: "Buy, send, sell back" });
  await expect(exit.getByRole("heading", { name: "No venue with liquidity" })).toBeVisible();
  await expect(exit).toContainText("No liquidity reads as no liquidity");
  await expect(exit).toContainText("No venue was found.");
  await expect(exit).toContainText("no Uniswap V2 pair with WETH");
  await expect(exit.getByRole("listitem")).toHaveCount(0);

  await expect(finding(page, "Trading venue")).toContainText("Not found");
  await expect(finding(page, "Sell or transfer shortfall")).toContainText("Skipped");
  await expect(page.getByText(`Measured on-chain at block ${BLOCK}. Not a trading signal.`)).toBeVisible();
  await fitsTheScreen(page);
});

test("top holders and the deployer from Blockscout's index, through Hyvo's API and labelled so", async ({ page }) => {
  await stubCheck(page, { name: "Quiet Token", symbol: "QT" });
  const holders = await stubHolders(page);
  await open(page, `/check/${TOKEN}`);
  await expect(page.getByRole("heading", { name: "QT Quiet Token", level: 2 })).toBeVisible();
  expect(holders.asked).toEqual([`http://api.test/v1/check/${TOKEN}/holders`]);

  // The pair holds pool liquidity and is left out: the holder and the deployer hold 30% of the supply.
  const top = finding(page, "Top holders");
  await expect(top).toContainText("Found");
  await expect(top).toContainText("The 2 largest holders hold 30% of the supply, leaving out burn addresses, the Uniswap V4 PoolManager, the Uniswap V2 pair");
  await expect(top).toContainText("3 holders in all");
  await expect(top).toContainText(`balances from ${SOURCE}, not read at block ${BLOCK}`);
  // Neither a launch record nor Sourcify names the deployer here, so Blockscout's creator does, with its source.
  const deployer = finding(page, "Deployer");
  await expect(deployer).toContainText("Found");
  await expect(deployer).toContainText(`in transaction ${CREATION_TX.slice(0, 10)}…${CREATION_TX.slice(-4)} (${SOURCE})`);
  await expect(deployer).toContainText(`${OWNER.slice(0, 6)}…${OWNER.slice(-4)}`);

  const findings = page.getByRole("region", { name: "Every check, with its evidence" });
  await expect(findings).toContainText(`Top holders and the deployer come from ${SOURCE}, not from the chain at block ${BLOCK}.`);
  await expect(page.getByRole("region", { name: "QT Quiet Token" })).toContainText("and 1 to Hyvo's API");
  await expect(page.getByRole("region", { name: "What this check cannot tell" })).toContainText("Holders come from an index.");
  await expect(page.getByText(`Measured on-chain at block ${BLOCK}. Not a trading signal.`)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/\b(safe|scam|rug|honeypot|legit|risky)\b/i);
  await fitsTheScreen(page);
});

test("when Hyvo's API has no answer for the holders, they stay skipped and say why", async ({ page }) => {
  await stubCheck(page);
  await stubHolders(page, { status: 503, body: { error: { code: "holders_disabled", message: "top holders are not read on this API" } } });
  await open(page, `/check/${TOKEN}`);
  const top = finding(page, "Top holders");
  await expect(top).toContainText("Skipped");
  await expect(top).toContainText("Hyvo's API does not read Blockscout's index at the moment, so the holders could not be read.");
  await expect(finding(page, "Deployer")).toContainText("Skipped");
  await expect(page.getByRole("region", { name: "Every check, with its evidence" })).not.toContainText("come from Blockscout's index");

  // An answer the page cannot read is no answer.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await stubCheck(page);
  await stubHolders(page, { status: 200, body: { ...FACTS, holders: [{ address: "0x12", value: "1" }] } });
  await page.getByRole("button", { name: "Check again at the latest block" }).click();
  await expect(finding(page, "Top holders")).toContainText("Hyvo's API did not answer with the token's holders from Blockscout's index.");
});

test("an address that is not one is refused, and nothing is read", async ({ page }) => {
  const log = await stubCheck(page);
  await open(page, "/check/0x1234");
  await expect(page.getByRole("alert")).toContainText("0x1234 is not a token address. A token address is 0x followed by 40 hexadecimal characters.");

  const field = page.getByLabel("Token address");
  await field.fill("0x8eee67a8aad993f15b4506975b38c52f6d3ce75");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByText("That is not a token address. Enter 0x followed by 40 hexadecimal characters")).toBeVisible();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/check\/0x1234$/);

  // A transaction hash is not an address either.
  await field.fill(`0x${"ab".repeat(32)}`);
  await field.press("Enter");
  await expect(field).toHaveAttribute("aria-invalid", "true");

  expect(log.rpc).toEqual([]);
  await fitsTheScreen(page);
});

test("before a check, the page says what it reads", async ({ page }) => {
  const log = await stubCheck(page);
  await open(page, "/check");
  await expect(page.getByRole("heading", { name: "How the exit simulation works" })).toBeVisible();
  await expect(page.getByRole("region", { name: "What each check looks for" }).getByRole("listitem")).toHaveCount(11);
  await expect(page.getByLabel("Token address")).toHaveValue("");
  expect(log.rpc).toEqual([]);
  await fitsTheScreen(page);
});

test("Hyvo Check is in the header, the footer and the list of what Hyvo does", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  const row = page.getByRole("region", { name: "What you can do with Hyvo" }).getByRole("listitem").filter({ hasText: "Hyvo Check" });
  await expect(row).toContainText("Live");
  await expect(row.getByRole("link", { name: "Hyvo Check" })).toHaveAttribute("href", "/check");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Hyvo Check" })).toHaveAttribute("href", "/check");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Check", exact: true }).click();
  await expect(page).toHaveURL(/\/check$/);
  await expect(page.getByRole("heading", { name: "Hyvo Check", level: 1 })).toBeVisible({ timeout: 30_000 });
  await fitsTheScreen(page);
});

test("the docs show the terminal commands, and the trust page how the simulation stays read-only", async ({ page }) => {
  await stubApi(page);
  await page.goto("/docs#cli");
  const cli = page.getByRole("region", { name: "Hyvo in your terminal" });
  await expect(cli.getByRole("heading", { name: "Hyvo in your terminal" })).toBeInViewport();
  await expect(cli).toContainText("npx @hyvo/cli check 0x…");
  await expect(cli).toContainText("It is on npm as @hyvo/cli");
  await fitsTheScreen(page);

  await page.goto("/trust#probe");
  const probe = page.getByRole("region", { name: "How Hyvo Check tries a sale" });
  await expect(probe).toContainText("never deployed");
  await expect(probe).toContainText("Nothing is signed or sent");
  await fitsTheScreen(page);
});
