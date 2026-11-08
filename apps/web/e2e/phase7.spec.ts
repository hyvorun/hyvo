import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DISCLAIMER, RunV1, hashRun, summarizeRun, type CloneView } from "@hyvo/schema";
import { expect, test, type Page } from "@playwright/test";
import { stubApi } from "./stub-api";
import { chainState, injectWallet, stubChain } from "./stub-chain";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" };

function fixture(name: string): { text: string; run: RunV1 } {
  const text = readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), "utf8");
  return { text, run: RunV1.parse(JSON.parse(text)) };
}

/** Serves one published run, whatever the rest of the stub says. */
async function serve(page: Page, { text, run }: { text: string; run: RunV1 }) {
  const summary = { ...summarizeRun(run), publishedAt: "2026-11-06T00:00:00Z", featured: false };
  await page.route(`http://api.test/v1/runs/${run.runId}`, (route) =>
    route.fulfill({ status: 200, headers: CORS, json: { run: summary, job: null, oracle: null, disclaimer: DISCLAIMER } }),
  );
  await page.route(`http://api.test/v1/runs/${run.runId}/artifact`, (route) =>
    route.fulfill({ status: 200, headers: CORS, json: { url: `http://api.test/bytes/${run.runId}`, expiresAt: "2099-01-01T00:00:00Z" } }),
  );
  await page.route(`http://api.test/bytes/${run.runId}`, (route) => route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: text }));
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a crowd with every kind of trader names each of them", async ({ page }) => {
  await stubApi(page);
  const ten = fixture("ten-personas-run.json");
  await serve(page, ten);
  await page.goto(`/run/${ten.run.runId}`);
  await expect(page.getByText("Hash verified in your browser")).toBeVisible();
  await expect(page.getByRole("img", { name: "20 synthetic agents, one dot each, filled by the tokens each one holds" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("crowd.png"), fullPage: true });
  await page.getByRole("button", { name: "Timeline" }).click();
  for (const label of ["Snipers", "Whales", "KOL", "Market", "Stock", "Newcomers"]) {
    await expect(page.locator("svg text").filter({ hasText: label }).first()).toBeVisible();
  }
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  await noHorizontalScroll(page);
});

/** A real run grown to `size` agents: the others only hold. Its ids change width, so it gets its own hash. */
function grown(source: RunV1, size: number): { text: string; run: RunV1 } {
  const rename = (id: string) => `a${id.slice(1).padStart(String(size).length, "0")}`;
  const padded = JSON.parse(JSON.stringify(source)) as RunV1;
  const extra = Array.from({ length: size - source.crowd.size }, (_, i) => source.crowd.size + i + 1);
  padded.crowd.size = size;
  padded.crowd.agents = padded.crowd.agents.map((agent) => ({ ...agent, agentId: rename(agent.agentId) }));
  padded.crowd.agents.push(
    ...extra.map((n) => ({ agentId: rename(`a${n}`), handle: `@agent${n}`, persona: "newcomer" as const, startEth: "0.1", startTokens: "0" })),
  );
  padded.crowd.personaMix.newcomer = (padded.crowd.personaMix.newcomer ?? 0) + extra.length;
  for (const round of padded.rounds) {
    for (const post of round.posts) post.agentId = rename(post.agentId);
    for (const action of round.actions) action.agentId = rename(action.agentId);
    round.actions.push(...extra.map((n) => ({ agentId: rename(`a${n}`), kind: "hold" as const, amountIn: null, amountOut: null, txHash: null, status: "ok" as const, note: null })));
  }
  padded.hash = hashRun(padded) as RunV1["hash"];
  const parsed = RunV1.parse(padded);
  return { text: JSON.stringify(parsed), run: parsed };
}

test("a crowd of a thousand replays, verifies and keeps its timeline a readable size", async ({ page }) => {
  await stubApi(page);
  const big = grown(fixture("ten-personas-run.json").run, 1000);
  await serve(page, big);
  await page.goto(`/run/${big.run.runId}`);
  await expect(page.getByText("Hash verified in your browser")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("img", { name: "1,000 synthetic agents, one dot each, filled by the tokens each one holds" })).toBeVisible();
  await expect(page.getByText("1,000 synthetic agents ·")).toBeVisible();
  await page.getByRole("button", { name: "Timeline" }).click();
  const chart = page.getByRole("img", { name: /crowd raster, 4 rounds, 1,000 agents/ });
  await expect(chart).toBeVisible();
  expect((await chart.boundingBox())!.height).toBeLessThan(800);
  await noHorizontalScroll(page);
});

test("a run whose file does not match its hash says so, also from the worker", async ({ page }) => {
  await stubApi(page);
  const ten = fixture("ten-personas-run.json");
  const changed = { ...ten.run, report: { ...ten.run.report, summary: `${ten.run.report.summary} Changed afterwards.` } };
  await serve(page, { text: JSON.stringify(changed), run: changed as RunV1 });
  await page.goto(`/run/${ten.run.runId}`);
  await expect(page.getByText("Hash does not match", { exact: false })).toBeVisible({ timeout: 30_000 });
});

// --- a run with a rewind, and a run with a clone ------------------------------------------------------

function rehash(run: RunV1): { text: string; run: RunV1 } {
  run.hash = hashRun(run) as RunV1["hash"];
  const parsed = RunV1.parse(run);
  return { text: JSON.stringify(parsed), run: parsed };
}

function rewound() {
  const run = JSON.parse(fixture("ten-personas-run.json").text) as RunV1;
  run.world.forkBlock = 106913859;
  const point = (n: number, price: string) => ({ block: 106913859 + n * 50_000, at: `2026-11-05T0${n}:00:00Z`, price, reserveEth: "2", reserveToken: "1000" });
  run.rewind = {
    pool: `0x${"73".repeat(20)}`,
    block: 106913859,
    at: "2026-11-05T00:00:00Z",
    hours: 6,
    change: "The rumor came two hours earlier.",
    actual: [point(0, "0.002"), point(1, "0.0024"), point(2, "0.003"), point(3, "0.0026"), point(4, "0.003")],
  };
  return rehash(run);
}

test("a rewind sits next to what actually happened, and says it is not a forecast", async ({ page }) => {
  await stubApi(page);
  const run = rewound();
  await serve(page, run);
  await page.goto(`/run/${run.run.runId}`);
  await expect(page.getByRole("heading", { name: "Next to what actually happened" })).toBeVisible();
  await expect(page.getByText("The rumor came two hours earlier.").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "block 106,913,859" }).first()).toHaveAttribute("href", /\/block\/106913859$/);
  await expect(page.getByRole("link", { name: "a real pool" })).toHaveAttribute("href", /\/address\/0x7373/);
  await expect(page.getByText("The real pool +50.0%")).toBeVisible();
  await expect(page.getByRole("img", { name: /the real pool \+50\.0%, over 6 hours/ })).toBeVisible();
  await expect(page.getByText("It is not a forecast of anything.")).toBeVisible();
  await noHorizontalScroll(page);
});

test("a run without a rewind or a clone shows neither panel", async ({ page }) => {
  await stubApi(page);
  const ten = fixture("ten-personas-run.json");
  await serve(page, ten);
  await page.goto(`/run/${ten.run.runId}`);
  await expect(page.getByText("Hash verified in your browser")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Next to what actually happened" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "The clone in this crowd" })).toHaveCount(0);
});

test("a run with a clone says what the clone did, in this synthetic market", async ({ page }) => {
  await stubApi(page);
  const run = JSON.parse(fixture("ten-personas-run.json").text) as RunV1;
  const agent = run.crowd.agents.find((item) => item.persona === "sniper")!;
  agent.persona = "clone";
  run.crowd.personaMix.sniper -= 1;
  run.crowd.personaMix.clone = 1;
  const served = rehash(run);
  await serve(page, served);
  await page.goto(`/run/${served.run.runId}`);
  const panel = page.getByRole("region", { name: "The clone in this crowd" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(agent.handle);
  await expect(panel).toContainText("in this synthetic market, before gas");
  await expect(panel).toContainText("not a measure of the wallet behind it");
  await noHorizontalScroll(page);
});

// --- /clone -----------------------------------------------------------------------------------------

const CORS_ALL = { ...CORS, "Access-Control-Allow-Methods": "GET, POST, DELETE" };
const PROFILE = {
  version: 1,
  trades: 40,
  buys: 25,
  sells: 15,
  tokens: 9,
  typicalBuyEth: 0.12,
  smallBuyEth: 0.05,
  largeBuyEth: 0.3,
  medianHoldHours: 3.5,
  soldWithinHourPct: 40,
  stillHeldPct: 20,
  medianSellPct: 100,
  medianEntryMinutes: 12,
  earlyEntryPct: 70,
} as const;

function view(status: CloneView["status"], extra: Partial<CloneView> = {}): CloneView {
  return { status, profile: status === "ready" ? PROFILE : null, failReason: null, updatedAt: "2026-11-06T00:00:00Z", ...extra };
}

async function withWallet(page: Page) {
  const state = chainState({ balance: 5_000_000n });
  await stubChain(page, state);
  await injectWallet(page, state);
}

/** `/v1/clones/me`, with the calls it received. */
async function stubClone(page: Page, start: { clone: CloneView | null; open?: boolean }, afterBuild: () => CloneView = () => view("building")) {
  const log: string[] = [];
  let current = start.clone;
  await page.route("http://api.test/v1/clones/me", async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS_ALL });
    log.push(method);
    if (method === "DELETE") {
      current = null;
      return route.fulfill({ status: 204, headers: CORS_ALL });
    }
    if (method === "POST") current = afterBuild();
    return route.fulfill({ status: method === "POST" ? 201 : 200, headers: CORS_ALL, json: { clone: current, open: start.open ?? true, disclaimer: DISCLAIMER } });
  });
  return { log, set: (next: CloneView | null) => (current = next) };
}

async function signedIn(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a clone starts with a signature, and only your own wallet", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  await stubClone(page, { clone: null });
  await page.goto("/clone");
  await expect(page.getByRole("heading", { name: "Wallet Clone", level: 1 })).toBeVisible();
  await expect(page.getByText("Only your own wallet can be cloned")).toBeVisible();
  await expect(page.getByLabel("Address")).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("building a clone shows its progress, then only numbers", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  const clone = await stubClone(page, { clone: null });
  await signedIn(page, "/clone");
  await page.getByRole("button", { name: "Build my clone" }).click();
  await expect(page.getByText("Reading your trades.")).toBeVisible();
  expect(clone.log).toContain("POST");
  clone.set(view("ready"));
  await expect(page.getByRole("heading", { name: "What the clone trades by" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("0.12 ETH, mostly 0.05 to 0.3 ETH")).toBeVisible();
  await expect(page.getByText("3.5 hours (median)")).toBeVisible();
  await expect(page.getByText("12 minutes (median)")).toBeVisible();
  await expect(page.getByText(/[0-9]\.[0-9]{3,}/)).toHaveCount(0);
  await expect(page.getByText("They hold no address, no token names and no dates.")).toBeVisible();
  await noHorizontalScroll(page);
});

test("clones that are not open say so", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  await stubClone(page, { clone: null, open: false });
  await signedIn(page, "/clone");
  await expect(page.getByText("Clones are not open yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Build my clone" })).toHaveCount(0);
});

test("a build that failed says why, and can be tried again", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  await stubClone(page, { clone: view("failed", { failReason: "this wallet has 2 trades on Robinhood Chain, and a clone needs at least 5" }) });
  await signedIn(page, "/clone");
  await expect(page.getByRole("alert")).toContainText("needs at least 5");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a clone runs in a crowd from the balance, and a short balance says where to top up", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  await stubClone(page, { clone: view("ready") });
  let sent: Record<string, unknown> | null = null;
  let answer: { status: number; json: unknown } = { status: 402, json: { error: { code: "insufficient_balance", message: "this run costs $1.00 and the balance is $0.00; top up first" } } };
  await page.route("http://api.test/v1/runs", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS_ALL });
    if (route.request().method() !== "POST") return route.fallback();
    sent = route.request().postDataJSON();
    return route.fulfill({ status: answer.status, headers: CORS_ALL, json: answer.json });
  });
  await signedIn(page, "/clone");
  await page.getByRole("button", { name: "Start the run" }).click();
  await expect(page.getByText("Give the scenario a title.")).toBeVisible();
  await page.getByLabel("Title").fill("A fictional token lists");
  await page.getByRole("button", { name: "Start the run" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("this run costs $1.00");
  await expect(alert.getByRole("link", { name: "Top up" })).toHaveAttribute("href", "/account");
  expect(sent).toMatchObject({ balance: true, clone: true, agents: 50, rounds: 10, scenario: { title: "A fictional token lists", events: [] } });
  const ten = fixture("ten-personas-run.json");
  answer = { status: 201, json: { runId: ten.run.runId, job: { status: "queued", attempt: 0, progress: null, queuedAt: "2026-11-06T00:00:00Z", startedAt: null, finishedAt: null, refund: null }, chargedUsd: 1 } };
  await serve(page, ten);
  await page.getByRole("button", { name: "Start the run" }).click();
  await expect(page).toHaveURL(/\/run\/run_/);
});

test("deleting a clone asks once, and leaves nothing on the page", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  const clone = await stubClone(page, { clone: view("ready") });
  await signedIn(page, "/clone");
  await page.getByRole("button", { name: "Delete my clone" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  expect(clone.log).not.toContain("DELETE");
  await page.getByRole("button", { name: "Delete my clone" }).click();
  await page.getByRole("button", { name: "Delete for good" }).click();
  await expect(page.getByRole("heading", { name: "What the clone trades by" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Build my clone" })).toBeVisible();
  expect(clone.log).toContain("DELETE");
});

// --- /rewind ----------------------------------------------------------------------------------------

test("the rewind form holds one change, and sends it", async ({ page }) => {
  await stubApi(page);
  await withWallet(page);
  let sent: Record<string, unknown> | null = null;
  await page.route("http://api.test/v1/runs", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS_ALL });
    if (route.request().method() !== "POST") return route.fallback();
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 402, headers: CORS_ALL, json: { error: { code: "insufficient_balance", message: "this run costs $1.00 and the balance is $0.00; top up first" } } });
  });
  await page.goto("/rewind");
  await expect(page.getByText("It does not forecast anything")).toBeVisible();
  await page.getByRole("button", { name: "Start the rewind" }).click();
  await expect(page.getByText("Use the pool's contract address")).toBeVisible();
  await expect(page.getByText("Use a block number.")).toBeVisible();
  await expect(page.getByText("Say the one thing that is different this time.")).toBeVisible();
  await page.getByLabel("Pool address").fill(`0x${"73".repeat(20)}`);
  await page.getByLabel("Block", { exact: true }).fill("106913859");
  await page.getByLabel("Hours to compare").fill("200");
  await page.getByLabel("What is different this time").fill("The rumor came two hours earlier.");
  await page.getByRole("button", { name: "Start the rewind" }).click();
  await expect(page.getByText("Choose 1 to 72 hours.")).toBeVisible();
  await page.getByLabel("Hours to compare").fill("6");
  await page.getByRole("button", { name: "Start the rewind" }).click();
  await expect(page.getByRole("alert")).toContainText("this run costs $1.00");
  expect(sent).toMatchObject({
    balance: true,
    rewind: { pool: `0x${"73".repeat(20)}`, block: 106913859, hours: 6 },
    agents: 50,
    rounds: 10,
    scenario: { title: "Rewind of block 106,913,859", events: [{ round: 3, text: "The rumor came two hours earlier." }] },
  });
  await noHorizontalScroll(page);
});

// --- before payments open -----------------------------------------------------------------------------

test.describe("before payments open", () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
    await page.route("http://api.test/v1/health", (route) =>
      route.fulfill({
        status: 200,
        headers: CORS,
        json: { ok: true, version: "test", features: { payments: false, oracle: true, holder: false, clone: false }, limits: { minAgents: 10, maxAgents: 2000, minRounds: 3, maxRounds: 30, maxDecisions: 840 } },
      }),
    );
  });

  for (const path of ["/rewind", "/dryrun"]) {
    test(`${path} says so before anyone fills it in`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("status").filter({ hasText: "Paid runs are not open yet" })).toBeVisible();
    });
  }
});

test("once payments are open, the forms say nothing about it", async ({ page }) => {
  await stubApi(page);
  await page.goto("/rewind");
  await expect(page.getByRole("heading", { name: "Rewind", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Paid runs are not open yet")).toHaveCount(0);
});

