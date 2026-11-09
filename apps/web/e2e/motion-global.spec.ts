import { expect, test, type Page } from "@playwright/test";
import { stubApi } from "./stub-api";

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

/** The nav's sliding line, as the screen draws it. */
function line(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('nav[aria-label="Main"] > span[aria-hidden="true"]')!;
    const box = bar.getBoundingClientRect();
    return { left: box.left, right: box.right, opacity: Number(getComputedStyle(bar).opacity), display: getComputedStyle(bar).display };
  });
}

async function under(page: Page, name: string): Promise<boolean> {
  const link = await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name }).boundingBox();
  const bar = await line(page);
  return bar.opacity > 0.9 && bar.left >= link!.x - 0.5 && bar.right <= link!.x + link!.width + 0.5 && bar.right - bar.left > 10;
}

test("the nav line slides to the link under the pointer and back to the page's link", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "a pointer hover");
  await page.goto("/runs");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toHaveAttribute("data-ready", "true");
  await expect.poll(() => under(page, "Runs")).toBe(true);
  await nav.getByRole("link", { name: "Docs" }).hover();
  await expect.poll(() => under(page, "Docs")).toBe(true);
  await page.mouse.move(700, 600);
  await expect.poll(() => under(page, "Runs")).toBe(true);
  // A new page: the line follows the new page's link.
  await nav.getByRole("link", { name: "Tools" }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await page.mouse.move(700, 600);
  await expect.poll(() => under(page, "Tools")).toBe(true);
});

test("on a phone the links scroll sideways, the page's link is brought into view and the line is under it", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "a phone's sideways scroll");
  const nav = page.getByRole("navigation", { name: "Main" });
  /** The link lies wholly inside the scrolling row. */
  const inView = async (name: string) => {
    const row = (await nav.boundingBox())!;
    const link = (await nav.getByRole("link", { name, exact: true }).boundingBox())!;
    return link.x >= row.x - 0.5 && link.x + link.width <= row.x + row.width + 0.5;
  };
  await page.goto("/docs");
  await expect(nav).toHaveAttribute("data-ready", "true");
  expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  for (const name of ["Runs", "Check", "Launches", "Stocks", "Tools", "Docs"]) await expect(nav.getByRole("link", { name, exact: true })).toBeAttached();
  // Docs is the last link, out of the row at first: the row has scrolled to it, and the line followed.
  await expect.poll(() => inView("Docs")).toBe(true);
  await expect.poll(() => under(page, "Docs")).toBe(true);
  // Scrolled to the far end, the row glides back to the next page's link.
  await nav.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: "instant" }));
  await page.getByRole("contentinfo").getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect.poll(() => inView("Runs")).toBe(true);
  await expect.poll(() => under(page, "Runs")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test("the header's hairline settles in once the page scrolls, without changing its height", async ({ page }) => {
  await page.goto("/");
  const header = page.getByRole("banner");
  await expect(header).toHaveAttribute("data-scrolled", "false");
  const before = (await header.boundingBox())!.height;
  await page.mouse.wheel(0, 600);
  await expect(header).toHaveAttribute("data-scrolled", "true");
  await expect.poll(() => header.evaluate((el) => getComputedStyle(el).borderBottomColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect((await header.boundingBox())!.height).toBe(before);
});

test("the theme switch still switches, and leaves nothing behind", async ({ page }) => {
  await page.goto("/runs");
  const html = page.locator("html");
  await page.getByRole("button", { name: "Switch to the light theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).not.toHaveAttribute("data-switching", /.+/);
  await page.getByRole("button", { name: "Switch to the dark theme" }).click();
  await expect(html).not.toHaveAttribute("data-theme", /.+/);
  await expect(page.getByRole("button", { name: "Switch to the light theme" })).toBeVisible();
});

test("a disclosure opens and its chevron turns", async ({ page }) => {
  await page.goto("/new");
  const summary = page.getByText("Market settings (optional)");
  const turn = () => summary.evaluate((el) => getComputedStyle(el, "::before").transform);
  const closed = await turn();
  await summary.click();
  await expect(page.getByLabel("Token symbol")).toBeVisible();
  await expect.poll(turn).not.toBe(closed);
});

test("a checkbox draws its check when ticked", async ({ page }) => {
  await page.goto("/tools/checklist");
  const box = page.getByRole("checkbox").first();
  const stroke = () => box.evaluate((el) => new DOMMatrix(getComputedStyle(el, "::after").transform).a);
  expect(await stroke()).toBe(0);
  await box.check();
  await expect(box).toBeChecked();
  await expect.poll(stroke).toBeGreaterThan(0.6);
});

test("the skip link slides into view when it has focus", async ({ page }) => {
  await page.goto("/runs");
  const skip = page.getByRole("link", { name: "Skip to content" });
  expect((await skip.boundingBox())!.y + (await skip.boundingBox())!.height).toBeLessThanOrEqual(0);
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect.poll(async () => (await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
});

test("with reduced motion everything shows at once and the page's link keeps a static underline", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".reveal, .reveal > *")].filter((el) => getComputedStyle(el).opacity !== "1").length,
  );
  expect(hidden).toBe(0);
  await page.goto("/runs");
  expect((await line(page)).display).toBe("none");
  const underline = await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Runs" })
    .evaluate((el) => getComputedStyle(el, "::after").opacity);
  expect(underline).toBe("1");
});
