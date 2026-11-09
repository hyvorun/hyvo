import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The header's breakpoints. Browser zoom and non-integer device scales give a screen a fractional
 * width in CSS px (1281 device px at 200% is 640.5px), so a pair like max-width: 640px and
 * min-width: 641px leaves widths where neither side's rules apply.
 */

const css = readFileSync(new URL("../src/components/Layout.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};

/** Whether a media query made only of width conditions matches a screen `width` px wide; null if it asks for anything else. */
function matchesWidth(query: string, width: number): boolean | null {
  const negated = query.match(/^not\s+all\s+and\s+(.+)$/);
  if (negated) {
    const inner = matchesWidth(negated[1]!, width);
    return inner === null ? null : !inner;
  }
  let matches = true;
  for (const condition of query.split(/\s+and\s+/)) {
    const feature = condition.trim().replace(/^\(\s*|\s*\)$/g, "");
    const plain = feature.match(/^(min|max)-width:\s*([\d.]+)px$/);
    const range = feature.match(/^(?:([\d.]+)px\s*([<>]=?)\s*)?width(?:\s*([<>]=?)\s*([\d.]+)px)?$/);
    if (plain) {
      matches &&= plain[1] === "min" ? width >= Number(plain[2]) : width <= Number(plain[2]);
    } else if (range && (range[1] || range[4])) {
      if (range[1]) matches &&= COMPARE[range[2]!]!(Number(range[1]), width);
      if (range[4]) matches &&= COMPARE[range[3]!]!(width, Number(range[4]));
    } else {
      return null;
    }
  }
  return matches;
}

/** Every style rule of a stylesheet with the @media queries it sits in, outermost first. */
function rulesWithMedia(source: string): { selector: string; media: string[] }[] {
  const rules: { selector: string; media: string[] }[] = [];
  const open: (string | null)[] = [];
  for (const match of source.matchAll(/([^{}]*)\{|\}/g)) {
    if (match[1] === undefined) {
      open.pop();
      continue;
    }
    const prelude = match[1].trim();
    if (prelude.startsWith("@media")) {
      open.push(prelude.replace(/^@media\s+/, ""));
    } else {
      rules.push({ selector: prelude, media: open.filter((query): query is string => query !== null) });
      open.push(null);
    }
  }
  return rules;
}

describe("matchesWidth", () => {
  it("reads min-width, max-width, a negation and range syntax", () => {
    expect(matchesWidth("(max-width: 640px)", 640)).toBe(true);
    expect(matchesWidth("(max-width: 640px)", 640.5)).toBe(false);
    expect(matchesWidth("(min-width: 641px) and (max-width: 799px)", 641)).toBe(true);
    expect(matchesWidth("not all and (max-width: 640px)", 640)).toBe(false);
    expect(matchesWidth("not all and (max-width: 640px)", 640.01)).toBe(true);
    expect(matchesWidth("not all and (min-width: 900px)", 899.99)).toBe(true);
    expect(matchesWidth("(640px < width < 800px)", 640.5)).toBe(true);
    expect(matchesWidth("(width >= 900px)", 899.9)).toBe(false);
    expect(matchesWidth("(prefers-reduced-motion: no-preference)", 700)).toBeNull();
    expect(matchesWidth("(min-width: 1140px) and (hover: hover)", 1200)).toBeNull();
  });
});

describe("rulesWithMedia", () => {
  it("keeps the queries of every block a rule sits in", () => {
    expect(rulesWithMedia(".w { color: red; } @media (a) { @media (b) { .x { color: red; } } .y { color: blue; } } @media (c) { .z { color: red; } }")).toEqual([
      { selector: ".w", media: [] },
      { selector: ".x", media: ["(a)", "(b)"] },
      { selector: ".y", media: ["(a)"] },
      { selector: ".z", media: ["(c)"] },
    ]);
  });
});

describe("the header's breakpoints", () => {
  const rules = rulesWithMedia(css).filter((rule) => rule.media.length > 0 && rule.media.every((query) => matchesWidth(query, 1000) !== null));
  const applying = (width: number) =>
    rules
      .filter((rule) => rule.media.every((query) => matchesWidth(query, width)))
      .map((rule) => `${rule.media.join(" > ")} ${rule.selector}`)
      .join(" | ");
  const hides = (selector: string, width: number) => rules.some((rule) => rule.selector === selector && rule.media.every((query) => matchesWidth(query, width)));

  it("are found", () => {
    expect(rules.length).toBeGreaterThanOrEqual(10);
  });

  it("leave no fractional width between two of them where neither side's rules apply", () => {
    for (let width = 320; width < 1400; width++) {
      for (const fraction of [0.01, 0.5, 0.99]) {
        expect([applying(width), applying(width + 1)], `${width + fraction}px`).toContain(applying(width + fraction));
      }
    }
  });

  it("let the links that are not essential give way wherever the bar is short of room and does not scroll", () => {
    expect([640, 640.01, 640.5, 641, 799, 799.99, 800].map((width) => hides(".roomy", width))).toEqual([false, true, true, true, true, true, false]);
    expect([640, 899, 899.5, 899.99, 900].map((width) => hides(".wideOnly", width))).toEqual([true, true, true, true, false]);
  });
});
