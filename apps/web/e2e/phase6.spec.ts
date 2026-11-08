import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { golden, stubApi, summary } from "./stub-api";
import { chainState, injectWallet, stubChain } from "./stub-chain";

const RUN_A = golden.runId;
const RUN_B = "run_01M6GCKE58E5YXTK38CQ5RRWEB";
const DISCLAIMER = "Synthetic crowd reaction. Not a trading signal.";

const hit = {
  runId: RUN_A,
  title: "Fictional token GLINT lists",
  question: "Was GLINT above its launch price a week later?",
  resolvesAt: "2026-11-10T00:00:00Z",
  expectation: "yes",
  yes: 30,
  no: 15,
  unsure: 5,
  outcome: "yes",
  result: "hit",
  note: "Public pool data at the date.",
  evidenceUrl: "https://pools.example/glint",
  decidedAt: "2026-11-10T01:00:00Z",
  txHash: `0x${"ab".repeat(32)}`,
  onChain: true,
};
const miss = { ...hit, runId: RUN_B, question: "Did MOSS keep its team a month later?", expectation: "no", yes: 10, no: 35, outcome: "yes", result: "miss", evidenceUrl: null };
const open = { runId: RUN_B, title: "Fictional token ORBIT", question: "Will ORBIT list on a second exchange by December?", resolvesAt: "2099-12-01T00:00:00Z", expectation: "split", yes: 20, no: 20, unsure: 10, overdue: false };

function record(body: unknown) {
  return async (page: Page) => {
    await page.route("http://api.test/v1/calibration", (route) => route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, json: body }));
  };
}

const full = {
  counts: { hits: 1, misses: 1, noLean: 2, void: 1, open: 1 },
  hitRate: 0.5,
  buckets: [
    { label: "50-60%", hits: 0, misses: 0 },
    { label: "60-70%", hits: 1, misses: 0 },
    { label: "70-80%", hits: 0, misses: 1 },
    { label: "80-90%", hits: 0, misses: 0 },
    { label: "90-100%", hits: 0, misses: 0 },
  ],
  resolved: [miss, hit],
  open: [open],
  disclaimer: DISCLAIMER,
};

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a resolved question appears on the calibration page, a miss as plainly as a hit", async ({ page }) => {
  await stubApi(page);
  await record(full)(page);
  await page.goto("/calibration");
  await expect(page.getByRole("heading", { name: "Calibration", level: 1 })).toBeVisible();
  const tally = page.getByLabel("The record so far");
  await expect(tally.getByText("Hits")).toBeVisible();
  await expect(tally.getByText("Misses")).toBeVisible();
  await expect(tally.getByText("50%")).toBeVisible();
  await expect(page.getByText(miss.question)).toBeVisible();
  await expect(page.getByText(hit.question)).toBeVisible();
  await expect(page.getByText("Miss", { exact: true })).toBeVisible();
  await expect(page.getByText("Hit", { exact: true })).toBeVisible();
  await expect(page.getByText("The crowd leaned no. The outcome was yes.")).toBeVisible();
  await expect(page.getByText("Left out of the rate: 2 where the crowd was split, 1 declared void.")).toBeVisible();
  await expect(page.getByRole("link", { name: "evidence" })).toHaveAttribute("href", hit.evidenceUrl);
  await expect(page.getByText(DISCLAIMER)).toBeVisible();
  await noHorizontalScroll(page);

  // A miss weighs the same as a hit: the same size, in the same place, in order of date.
  const tags = page.locator("li p span:first-child").filter({ hasText: /^(Miss|Hit)$/ });
  await expect(tags).toHaveCount(2);
  const [missBox, hitBox] = [await tags.nth(0).boundingBox(), await tags.nth(1).boundingBox()];
  expect(missBox!.height).toBe(hitBox!.height);
  expect(missBox!.y).toBeLessThan(hitBox!.y);
});

test("an open question shows the lean and its date", async ({ page }) => {
  await stubApi(page);
  await record(full)(page);
  await page.goto("/calibration");
  await expect(page.getByRole("heading", { name: "Open" })).toBeVisible();
  await expect(page.getByText(open.question)).toBeVisible();
  await expect(page.getByText("The crowd was split.")).toBeVisible();
});

test("before anything is resolved the page says so instead of showing a rate", async ({ page }) => {
  await stubApi(page);
  await record({ counts: { hits: 0, misses: 0, noLean: 0, void: 0, open: 0 }, hitRate: null, buckets: [], resolved: [], open: [], disclaimer: DISCLAIMER })(page);
  await page.goto("/calibration");
  await expect(page.getByText("No question has been resolved yet.")).toBeVisible();
  await expect(page.getByText("n/a")).toBeVisible();
  await expect(page.getByText("By how firm the lean was")).toHaveCount(0);
});

test("the form can ask a question and refuses half of one", async ({ page }) => {
  const api = await stubApi(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByLabel("A yes or no question for the crowd").fill("Will FIZZ stay above its launch price for a week?");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("Give the question a date.")).toBeVisible();
  await page.getByLabel("When the outcome is known").fill("2099-12-01");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("$1.00")).toBeVisible();
  const quote = api.requests.find((request) => request.path === "/v1/quotes")!;
  expect(quote.body).toMatchObject({ question: { text: "Will FIZZ stay above its launch price for a week?", resolvesAt: "2099-12-01T00:00:00Z" } });
});

test("the run page shows the question, the lean and its outcome", async ({ page }) => {
  await stubApi(page);
  const summaryQuestion = { text: hit.question, resolvesAt: hit.resolvesAt, expectation: "yes", yes: 30, no: 15, unsure: 5 };
  await page.route(`http://api.test/v1/runs/${RUN_A}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      json: {
        run: { ...summary, question: summaryQuestion },
        job: null,
        oracle: null,
        outcome: { outcome: "yes", note: "Public pool data at the date.", evidenceUrl: null, decidedAt: hit.decidedAt, txHash: hit.txHash, status: "confirmed" },
        disclaimer: DISCLAIMER,
      },
    }),
  );
  await page.goto(`/run/${RUN_A}`);
  const block = page.getByRole("region", { name: "The crowd's answer" });
  await expect(block.getByText(hit.question)).toBeVisible();
  await expect(block.getByText("The synthetic crowd leaned yes: 30 yes, 15 no, 5 unsure.")).toBeVisible();
  await expect(block.getByText(/The outcome was yes/)).toBeVisible();
  await expect(block.getByRole("link", { name: "Calibration" })).toHaveAttribute("href", "/calibration");
});

// --- Dry Run --------------------------------------------------------------------------------------

const REPORT = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/dryrun-sample.json", import.meta.url)), "utf8"));
const DRY_ID = REPORT.runId as string;

function dryView(status: string, extra: Record<string, unknown> = {}) {
  return {
    runId: DRY_ID,
    title: "A savings vault.",
    status,
    progress: null,
    queuedAt: "2026-11-06T00:00:00Z",
    finishedAt: null,
    chargedUsd: 1,
    hash: null,
    summary: null,
    failReason: null,
    refund: null,
    ...extra,
  };
}

async function stubDryRuns(page: Page, status: () => Record<string, unknown>, onCreate?: (body: unknown) => { status: number; json: unknown }) {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, DELETE" };
  await page.route("http://api.test/v1/dryruns**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    if (path === "/v1/dryruns" && request.method() === "POST") {
      const answer = onCreate?.(request.postDataJSON()) ?? { status: 201, json: { dryRun: dryView("queued"), disclaimer: DISCLAIMER } };
      return route.fulfill({ status: answer.status, headers, json: answer.json });
    }
    if (path === "/v1/dryruns") return route.fulfill({ status: 200, headers, json: { dryRuns: [], disclaimer: DISCLAIMER } });
    if (path.endsWith("/report")) return route.fulfill({ status: 200, headers, json: REPORT });
    return route.fulfill({ status: 200, headers, json: { dryRun: status(), disclaimer: DISCLAIMER } });
  });
}

async function withWallet(page: Page) {
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
}

test("a report surfaces the planted bugs, with how to reproduce them", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  await stubDryRuns(page, () => dryView("complete", { hash: REPORT.hash, summary: { status: "complete", findings: { high: 7, medium: 0, low: 2, info: 0 }, calls: 96, reverted: 3 } }));
  await page.goto(`/dryrun/${DRY_ID}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "isSolvent() became false" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "rescueFunds(address) can be called by anyone" })).toBeVisible();
  await expect(page.getByText("This file matches its hash, checked in your browser.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invariants: 0 of 1 held" })).toBeVisible();
  await expect(page.getByText("did not hold")).toBeVisible();
  await expect(page.getByText(/not an audit/)).toBeVisible();
  await expect(page.getByText("Synthetic crowd reaction. Not a trading signal.", { exact: false })).toBeVisible();

  const first = page.getByRole("listitem").filter({ hasText: "isSolvent() became false" });
  await first.getByText(/How to reproduce it/).click();
  await expect(first.getByText(/withdraw\(uint256\)/).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "deposit()", exact: true })).toBeVisible();
  await noHorizontalScroll(page);
});

test("a Dry Run that is still playing says so and picks up its report", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  let polls = 0;
  await stubDryRuns(page, () => (++polls < 3 ? dryView("running", { progress: { round: polls, rounds: 8 } }) : dryView("complete", { hash: REPORT.hash })));
  await page.goto(`/dryrun/${DRY_ID}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "The crowd is trying it" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "isSolvent() became false" })).toBeVisible({ timeout: 20_000 });
});

test("a Dry Run that failed says why and where the money went", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  await stubDryRuns(page, () => dryView("failed", { failReason: "invalid job: the contract's constructor reverted", refund: "credited" }));
  await page.goto(`/dryrun/${DRY_ID}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("the contract's constructor reverted")).toBeVisible();
  await expect(page.getByText("What it cost went back to your balance.")).toBeVisible();
});

test("the form sends a submission and opens its page", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  let sent: Record<string, unknown> | null = null;
  await stubDryRuns(page, () => dryView("queued"), (body) => {
    sent = body as Record<string, unknown>;
    return { status: 201, json: { dryRun: dryView("queued"), disclaimer: DISCLAIMER } };
  });
  await page.goto("/dryrun");
  await page.getByLabel("Not deployed yet").check();
  await page.getByRole("button", { name: "Start the Dry Run" }).click();
  await expect(page.getByText("Use 0x and an even number of hex digits")).toBeVisible();
  await expect(page.getByText("Bytecode needs its ABI.")).toBeVisible();
  await page.getByLabel("Creation bytecode").fill("0x6000");
  await page.getByLabel("ABI", { exact: true }).fill('[{"type":"function","name":"deposit","inputs":[],"stateMutability":"payable"}]');
  await page.getByLabel("What it does, in plain language").fill("A savings vault.");
  await page.getByLabel("Invariants (optional)").fill("isSolvent, not a name");
  await page.getByRole("button", { name: "Start the Dry Run" }).click();
  await expect(page.getByText("Give names of view functions")).toBeVisible();
  await page.getByLabel("Invariants (optional)").fill("isSolvent");
  await page.getByRole("button", { name: "Start the Dry Run" }).click();
  await expect(page).toHaveURL(new RegExp(`/dryrun/${DRY_ID}$`));
  expect(sent).toMatchObject({ balance: true, bytecode: "0x6000", invariants: ["isSolvent"], agents: 12, rounds: 8, description: "A savings vault." });
  await noHorizontalScroll(page);
});

test("a short balance is explained, with where to top up", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  await stubDryRuns(page, () => dryView("queued"), () => ({ status: 402, json: { error: { code: "insufficient_balance", message: "this Dry Run costs $1.00 and the balance is $0.00; top up first" } } }));
  await page.goto("/dryrun");
  await page.getByLabel("Contract address").fill(`0x${"1".repeat(40)}`);
  await page.getByLabel("What it does, in plain language").fill("A savings vault.");
  await page.getByRole("button", { name: "Start the Dry Run" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("this Dry Run costs $1.00");
  await expect(alert.getByRole("link", { name: "Top up" })).toHaveAttribute("href", "/account");
});

// --- the crowd's mix ------------------------------------------------------------------------------

test("the form can choose who is in the crowd, and refuses a mix that does not add up", async ({ page }) => {
  const api = await stubApi(page);
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
  await page.goto("/new");
  await page.getByLabel("Title").fill("Fictional token FIZZ lists");
  await page.getByText("Who is in the crowd (optional)").click();
  await page.getByLabel("Whales").fill("10");
  await page.getByLabel("Newcomers").fill("30");
  await expect(page.getByRole("status").filter({ hasText: "agents assigned" })).toContainText("40 of 50 agents assigned");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("The mix adds up to 40, and the crowd has 50 agents.")).toBeVisible();
  await page.getByLabel("Newcomers").fill("forty");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("Use a whole number.")).toBeVisible();
  await page.getByLabel("Newcomers").fill("40");
  await page.getByRole("button", { name: "Get a price" }).click();
  await expect(page.getByText("$1.00")).toBeVisible();
  const quote = api.requests.find((request) => request.path === "/v1/quotes")!;
  expect(quote.body).toMatchObject({ agents: 50, mix: { whale: 10, newcomer: 40 } });
  await noHorizontalScroll(page);
});

