import { expect, test } from "@playwright/test";
import { golden, stubApi } from "./stub-api";

/*
 * The data motion: numbers that count, hashes that decode, the replay's draw-in. What is checked
 * here is what matters beyond the look: the final value is in the page from the start (for screen
 * readers, copying and the other tests), the motion ends, and reduced motion shows everything at once.
 */

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

const decisions = golden.crowd.size * golden.rounds.length;

test("a number that counts up holds its final value in the page throughout, and the count ends", async ({ page }) => {
  await page.goto("/");
  const path = page.getByRole("region", { name: "Every number above comes from one run you can check." });
  const counts = path.locator("p", { hasText: "decisions" });
  await counts.scrollIntoViewIfNeeded();
  // The text is final at once, whatever is being drawn over it.
  await expect(counts).toContainText(`${decisions.toLocaleString("en-US")} decisions`);
  // The count finishes: nothing is drawn over the number any more.
  await expect(counts.locator("[data-shown]")).toHaveCount(0, { timeout: 5_000 });
});

test("a hash decodes into place, and only the real hash is ever in the page", async ({ page }) => {
  await page.goto(`/run/${golden.runId}`);
  const chip = page.getByRole("button", { name: "Copy the run hash" });
  const short = `${golden.hash.slice(0, 10)}…${golden.hash.slice(-6)}`;
  await expect(chip).toHaveText(short);
  await expect(chip.locator("[data-shown]")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByText("Hash verified in your browser")).toBeVisible();
});

test("the play button keeps both marks and shows the one that applies", async ({ page }) => {
  await page.goto(`/run/${golden.runId}`);
  const play = page.getByRole("button", { name: /Play replay|Replay from the start/ });
  const icon = play.locator("[data-state]");
  await expect(icon).toHaveAttribute("data-state", "play");
  await expect(icon.locator("svg")).toHaveCount(2);
  await play.click();
  await expect(page.getByRole("button", { name: "Pause replay" }).locator("[data-state]")).toHaveAttribute("data-state", "pause");
});

test("with reduced motion, every number and hash is final at once and nothing waits to appear", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const path = page.getByRole("region", { name: "Every number above comes from one run you can check." });
  await expect(path.locator("p", { hasText: "decisions" })).toContainText(`${decisions.toLocaleString("en-US")} decisions`);
  await expect(page.locator("[data-shown]")).toHaveCount(0);
  // The headline is not held under its mask.
  const word = page.getByRole("heading", { level: 1 }).locator("span span").first();
  await expect(word).toHaveCSS("transform", "none");
  await page.goto(`/run/${golden.runId}`);
  await expect(page.getByText("Hash verified in your browser")).toBeVisible();
  await expect(page.locator("[data-shown]")).toHaveCount(0);
});
