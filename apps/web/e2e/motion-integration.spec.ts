import { expect, test, type Page } from "@playwright/test";
import { golden, stubApi } from "./stub-api";

/*
 * The two motion layers together: the page entrances (Reveal, .stagger, the run path) and the
 * moving data (counts, decoding hashes) must never hide what keyboard focus lands on, and reduced
 * motion must leave nothing moving.
 */

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

/** The focused element and how visible it really is: its opacity times every ancestor's. */
function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return null;
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return { name: `${element.tagName} ${(element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 40)}`, opacity };
  });
}

test("keyboard focus never lands on a block that is still on its way in", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "a keyboard");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Let the opening entrance finish; what matters here is what scrolls in as focus moves down.
  await page.waitForTimeout(1200);
  const hidden: string[] = [];
  for (let step = 0; step < 60; step++) {
    await page.keyboard.press("Tab");
    const now = await focused(page);
    if (now && now.opacity < 0.9) hidden.push(`${now.name} (${now.opacity.toFixed(2)})`);
  }
  expect(hidden).toEqual([]);
});

/*
 * An IntersectionObserver whose callback runs late brings every entry queued since the last one,
 * oldest first. This one brings a stale "out of view" entry before the current ones, the first time.
 */
function lateObserver() {
  const Native = window.IntersectionObserver;
  window.IntersectionObserver = class extends Native {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      let first = true;
      super((entries, observer) => {
        if (first) {
          first = false;
          const stale = entries.map(
            (entry) =>
              ({
                target: entry.target,
                time: entry.time - 16,
                isIntersecting: false,
                intersectionRatio: 0,
                intersectionRect: new DOMRectReadOnly(),
                boundingClientRect: entry.boundingClientRect,
                rootBounds: entry.rootBounds,
              }) as IntersectionObserverEntry,
          );
          entries = [...stale, ...entries];
        }
        callback(entries, observer);
      }, options);
    }
  };
}

test("a late observer callback, with a stale entry before the current one, still brings the crowd and the blocks in", async ({ page }) => {
  await page.addInitScript(lateObserver);
  // Tall enough that a crowd and a block are on screen at once: no scroll calls the observers again.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 2400 });
  await page.goto("/");
  const crowd = page.locator("canvas").first();
  await expect(crowd).toBeInViewport();
  const drawn = () =>
    crowd.evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) count++;
      return count;
    });
  await expect.poll(drawn, { message: "the crowd's dots are drawn" }).toBeGreaterThan(0);
  const blocks = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".reveal")]
        .filter((block) => {
          const box = block.getBoundingClientRect();
          return box.top < innerHeight && box.bottom > 0;
        })
        .map((block) => block.getAttribute("data-in")),
    );
  expect((await blocks()).length).toBeGreaterThan(0);
  await expect.poll(blocks, { message: "every block on screen has come in" }).not.toContain("false");
});

test("under reduced motion nothing on the main pages is still moving once they have loaded", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const path of ["/", `/run/${golden.runId}`, "/tools", "/trust"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.mouse.wheel(0, 4000);
    // Reduced motion leaves 0.01ms transitions (base.css), which end on the next frame; anything
    // longer, or looping, is motion.
    const moving = () =>
      page.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => {
            const timing = animation.effect?.getComputedTiming();
            return animation.playState === "running" && (Number(timing?.duration) > 1 || timing?.iterations === Infinity);
          })
          .map((animation) => {
            const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
            const name = "animationName" in animation ? (animation as CSSAnimation).animationName : (animation as CSSTransition).transitionProperty;
            return `${name} on ${target?.tagName.toLowerCase()}.${target?.getAttribute("class")?.slice(0, 40) ?? ""}`;
          }),
      );
    await expect.poll(moving, { message: path, timeout: 3000 }).toEqual([]);
    // No passing value is drawn over a number or a hash.
    await expect(page.locator("[data-shown]")).toHaveCount(0);
  }
});
