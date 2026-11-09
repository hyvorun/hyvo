/**
 * A creator's launches and a launch's holder scan, against the fictional Pons world of @hyvo/launches/testing at
 * http://rpc.test and a stubbed Hyvo API at http://api.test (the creator route and the holders route). Nothing leaves
 * the test machine.
 */
import { PONS_V2_FACTORY, creatorLaunchToJson, type CreatorLaunch } from "@hyvo/launches";
import { DEMO_LAUNCHES, demoChain, fakeAddress, type FakeChain, type FakeLaunch } from "@hyvo/launches/testing";
import { expect, test, type Page } from "@playwright/test";
import { keccak256, toHex } from "viem";

const RPC = "http://rpc.test";
const FIZZ = DEMO_LAUNCHES[0]!;
const CREATOR = FIZZ.creator;
const POOL = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const SUPPLY = 10n ** 27n;
const pct = (n: number) => (SUPPLY * BigInt(n)) / 100n;
const wallet = (n: number) => fakeAddress(`e2e:holder:${n}`);
const READ_AT = "2026-11-09T07:12:00Z";

/** Two more launches by FIZZ's creator: one graduated, one still on its curve. */
const MORE: FakeLaunch[] = [
  { ...FIZZ, token: fakeAddress("e2e:token:a"), curve: fakeAddress("e2e:curve:a"), symbol: "ACORN", name: "Acorn", block: FIZZ.block - 500_000n, launchedAt: FIZZ.launchedAt - 52_083, phase: 2, liquidity: 0n },
  { ...FIZZ, token: fakeAddress("e2e:token:b"), curve: fakeAddress("e2e:curve:b"), symbol: "BIRCH", name: "Birch", block: FIZZ.block - 100_000n, launchedAt: FIZZ.launchedAt - 10_417, liquidity: 2_100_000_000_000_000_000n },
];

function world(): FakeChain {
  const chain = demoChain();
  chain.launches.push(...MORE);
  // Bought in FIZZ's launch second: wallet 1 and the creator; wallet 3 a few seconds later.
  chain.trades.push(
    { curve: FIZZ.curve, side: "buy", trader: wallet(1), quote: 10n ** 17n, tokens: pct(4), block: FIZZ.block },
    { curve: FIZZ.curve, side: "buy", trader: CREATOR, quote: 10n ** 17n, tokens: pct(6), block: FIZZ.block + 1n },
    { curve: FIZZ.curve, side: "buy", trader: wallet(3), quote: 10n ** 16n, tokens: pct(1), block: FIZZ.block + 40n },
  );
  chain.balances.set(
    FIZZ.token.toLowerCase(),
    new Map([
      [FIZZ.curve.toLowerCase(), pct(60)],
      [POOL.toLowerCase(), pct(10)],
      [CREATOR.toLowerCase(), pct(6)],
      [wallet(1).toLowerCase(), pct(3)],
      [wallet(2).toLowerCase(), pct(2)],
      [wallet(3).toLowerCase(), pct(1)],
      ["0x000000000000000000000000000000000000dead", pct(5)],
    ]),
  );
  return chain;
}

async function stubChain(page: Page, chain: FakeChain) {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST" };
  await page.route(`${RPC}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: chain.answerText(request.url(), request.postData() ?? "{}") });
  });
}

function launchJson(launch: FakeLaunch, i: number): ReturnType<typeof creatorLaunchToJson> {
  const event: CreatorLaunch = {
    token: launch.token,
    curve: launch.curve,
    pairToken: launch.pairToken,
    launchConfigId: 0n,
    graduationThreshold: launch.graduationThreshold,
    block: launch.block,
    timestamp: launch.launchedAt,
    txHash: keccak256(toHex(`e2e-launch-${i}`)),
    logIndex: 2,
  };
  return creatorLaunchToJson(event);
}

type ApiAnswer = { status: number; body: unknown } | "fail";

async function stubApi(page: Page, creator: ApiAnswer, holders: ApiAnswer = { status: 200, body: holdersBody() }) {
  const asked: string[] = [];
  const answer = (value: ApiAnswer) => async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    asked.push(route.request().url());
    if (value === "fail") return route.abort("connectionrefused");
    return route.fulfill({ status: value.status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(value.body) });
  };
  await page.route("http://api.test/v1/launches/creator/*", answer(creator));
  await page.route("http://api.test/v1/check/*/holders", answer(holders));
  return asked;
}

function creatorBody(launches: FakeLaunch[] = [FIZZ, ...MORE]) {
  return {
    creator: CREATOR,
    factory: PONS_V2_FACTORY,
    launches: [...launches].sort((a, b) => (a.block > b.block ? -1 : 1)).map(launchJson),
    complete: true,
    missing: null,
    source: "Blockscout's index of the Pons V2 factory's TokenLaunched logs, read through Hyvo's API at 07:12 UTC on 2026-11-09",
    readAt: READ_AT,
    disclaimer: `Launches from Blockscout's index of the factory's logs, read through Hyvo's API at ${READ_AT}. Each launch's state is read from the chain. Not a trading signal.`,
  };
}

function holdersBody() {
  return {
    token: FIZZ.token,
    source: "Blockscout's index, read through Hyvo's API at 07:12 UTC on 2026-11-09",
    totalSupply: SUPPLY.toString(),
    holderCount: 213,
    // The index's order and balances; the page re-reads every balance on-chain.
    holders: [FIZZ.curve, POOL, CREATOR, "0x000000000000000000000000000000000000dEaD", wallet(1), wallet(2), wallet(3)].map((address) => ({ address, value: "1" })),
    holdersMissing: null,
    creator: null,
    creatorMissing: "not asked",
    readAt: READ_AT,
    disclaimer: "Read from Blockscout's index through Hyvo's API. Not a trading signal.",
  };
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a creator's page lists the wallet's launches with each one's state, read at a named block", async ({ page }) => {
  const chain = world();
  await stubChain(page, chain);
  await stubApi(page, { status: 200, body: creatorBody() });
  await page.goto(`/launches/creator/${CREATOR}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(CREATOR.slice(0, 6));
  const stats = page.getByRole("list", { name: "This wallet on Pons" });
  await expect(stats.getByRole("listitem").first()).toContainText("3");
  await expect(stats.getByRole("listitem").nth(1)).toContainText("1");
  const rows = page.getByRole("region", { name: "Its launches, newest first" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("FIZZ");
  await expect(rows.nth(1)).toContainText("BIRCH");
  await expect(rows.nth(2)).toContainText("ACORN");
  await expect(rows.nth(2)).toContainText("Graduated");
  const status = page.getByText(/^Measured on-chain at block/).first();
  await expect(status).toContainText("109,867,700");
  await expect(status).toContainText("Not a trading signal.");
  await rows.nth(1).getByRole("link").click();
  await expect(page).toHaveURL(/\/launches\/0x/);
  await expect(page.getByRole("heading", { name: "BIRCH", level: 1 })).toBeVisible();
});

test("a launch's page counts its creator's launches and scans its holders", async ({ page }) => {
  const chain = world();
  await stubChain(page, chain);
  await stubApi(page, { status: 200, body: creatorBody() });
  await page.goto(`/launches/${FIZZ.token}`);
  await expect(page.getByRole("heading", { name: "FIZZ", level: 1 })).toBeVisible();
  await expect(page.getByText("This wallet launched")).toContainText("This wallet launched 3 tokens on Pons; 1 graduated.");
  await expect(page.getByRole("link", { name: "See the creator's launches" })).toHaveAttribute("href", `/launches/creator/${CREATOR}`);

  const holders = page.getByRole("region", { name: "Holders" });
  const figures = holders.getByRole("list", { name: "Holder figures" }).getByRole("listitem");
  await expect(figures.nth(0)).toContainText("213");
  // The creator 6%, wallets 3% + 2% + 1%: the curve, the pool and the burn address are left out.
  await expect(figures.nth(1)).toContainText("12%");
  await expect(figures.nth(2)).toContainText("6%");
  // Wallet 1 (3% now) and the creator (6%) bought in the launch second; wallet 3 bought later.
  await expect(figures.nth(3)).toContainText("9%");
  await expect(figures.nth(3)).toContainText("the 2 wallets that bought in the launch second, the creator among them");
  const list = holders.getByRole("list", { name: "Largest holders" }).getByRole("listitem");
  await expect(list).toHaveCount(7);
  await expect(list.nth(0)).toContainText("Curve");
  await expect(list.nth(0)).toContainText("60%");
  await expect(list.nth(1)).toContainText("Pool");
  await expect(list.nth(2)).toContainText("Creator");
  await expect(list.nth(2)).toContainText("First-second buyer");
  await expect(list.nth(3)).toContainText("Burn");
  await expect(holders.getByText(/^Measured on-chain at block/)).toContainText("Not a trading signal.");
  await noHorizontalScroll(page);
});

test("when Hyvo's API cannot list the launches, the pages say so and what to do", async ({ page }) => {
  const chain = world();
  await stubChain(page, chain);
  await stubApi(page, { status: 503, body: { error: { code: "creator_disabled", message: "off" } } }, "fail");
  await page.goto(`/launches/creator/${CREATOR}`);
  await expect(page.getByText("Hyvo's API does not read Blockscout's index at the moment")).toBeVisible();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();

  await page.goto(`/launches/${FIZZ.token}`);
  await expect(page.getByText("Its other launches could not be counted just now.")).toBeVisible();
  const holders = page.getByRole("region", { name: "Holders" });
  // Without the index's list, the creator's share and the launch second still come from the chain.
  await expect(holders.getByRole("list", { name: "Holder figures" }).getByRole("listitem").nth(2)).toContainText("6%");
  await expect(holders).toContainText("No list of the largest holders to show");
});

test("a creator page with a wallet that launched nothing, and with something that is not an address", async ({ page }) => {
  await stubChain(page, world());
  await stubApi(page, { status: 200, body: { ...creatorBody([]), creator: fakeAddress("nobody") } });
  await page.goto(`/launches/creator/${fakeAddress("nobody")}`);
  await expect(page.getByText("This wallet has not launched a token through the Pons V2 factory.")).toBeVisible();
  await page.goto("/launches/creator/0x1234");
  await expect(page.getByRole("heading", { name: "Not an address", level: 1 })).toBeVisible();
});
