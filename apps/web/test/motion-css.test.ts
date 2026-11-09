import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Checks on the stylesheets themselves. CSS modules rename every keyframe name a module uses to a
 * name local to that module, so `animation: rise …` in a .module.css runs only if that module
 * defines `@keyframes rise` itself; otherwise the animation silently never plays.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, suffix);
    return entry.name.endsWith(suffix) ? [path] : [];
  });
}

const KEYWORDS = new Set([
  "none", "infinite", "both", "forwards", "backwards", "alternate", "reverse", "normal", "alternate-reverse",
  "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "running", "paused",
  "initial", "inherit", "unset",
]);

/** Every keyframe name a stylesheet's animation and animation-name declarations ask for. */
function animationNames(css: string): string[] {
  const names: string[] = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of plain.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    // Functions (var(), calc(), linear(), steps()) never name keyframes.
    const value = match[1]!.replace(/[\w-]*\((?:[^()]|\([^()]*\))*\)/g, " ");
    for (const layer of value.split(",")) {
      for (const word of layer.trim().split(/\s+/)) {
        if (!word || KEYWORDS.has(word) || /^-?[\d.]+(?:m?s)?$/.test(word)) continue;
        names.push(word);
      }
    }
  }
  return names;
}

function keyframeNames(css: string): Set<string> {
  return new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!));
}

describe("animationNames", () => {
  it("finds names in shorthands with timing functions, delays and several layers", () => {
    expect(animationNames("a { animation: rise 700ms var(--ease-out) calc(var(--i, 0) * 70ms) both; }")).toEqual(["rise"]);
    expect(animationNames("a { animation: pop 460ms linear(0, 1.1, 1) backwards, fade 2s infinite; }")).toEqual(["pop", "fade"]);
    expect(animationNames("a { animation-name: sweep; } b { animation: none; }")).toEqual(["sweep"]);
    expect(animationNames("/* animation: ghost 1s */ a { color: red; }")).toEqual([]);
  });
});

describe("CSS modules", () => {
  const modules = files(SRC, ".module.css");

  it("are found", () => {
    expect(modules.length).toBeGreaterThan(20);
  });

  it.each(modules.map((path) => [path.slice(SRC.length + 1).replaceAll("\\", "/"), path]))(
    "%s defines every keyframe it animates with",
    (_name, path) => {
      const css = readFileSync(path, "utf8");
      const defined = keyframeNames(css);
      const missing = animationNames(css).filter((name) => !defined.has(name));
      expect(missing).toEqual([]);
    },
  );
});

describe("global stylesheets", () => {
  const globalCss = ["styles/base.css", "styles/ui.css"].map((name) => readFileSync(join(SRC, name), "utf8")).join("\n");

  it("define every keyframe they animate with", () => {
    const defined = keyframeNames(globalCss);
    expect(animationNames(globalCss).filter((name) => !defined.has(name))).toEqual([]);
  });
});

/** Every innermost rule of a stylesheet: its selector and its declarations. */
function rules(css: string): { selector: string; body: string }[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
}

/*
 * Keyboard focus never waits on an entrance, but it must not take the entrance away either: with
 * `animation: none` the finished animation is cancelled while focus is inside, and when focus leaves
 * the animation is added again and the whole entrance plays once more. Cutting its duration and delay
 * to nothing finishes one under way at once and leaves a finished one finished.
 */
describe("entrances under keyboard focus", () => {
  it.each(["styles/ui.css", "pages/CheckPage.module.css"])("%s cuts them short without taking them away", (name) => {
    const focused = rules(readFileSync(join(SRC, name), "utf8")).filter(
      (rule) => /:focus-within/.test(rule.selector) && /animation/.test(rule.body),
    );
    expect(focused.length).toBeGreaterThan(0);
    for (const rule of focused) {
      expect(rule.body, rule.selector).not.toMatch(/animation(?:-name)?\s*:\s*none/);
      expect(rule.body, rule.selector).toMatch(/animation-duration\s*:\s*0s\s*;/);
      expect(rule.body, rule.selector).toMatch(/animation-delay\s*:\s*0s\s*;/);
    }
  });
});
