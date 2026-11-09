// The layout `hyvo launches` and `hyvo stocks` share with `hyvo check`: a title line with the chain, a gray line
// of where and when, then facts as label, value and a gray note under the value. Text from the chain (names,
// symbols, terms) goes through oneLine() first, so it cannot carry terminal escape codes.

import { visibleLength, type Palette } from "../color.js";
import { joinFit, MAX_WIDTH, padEnd, spread, wrap } from "./text.js";

export const CHAIN_LABEL = "Robinhood Chain · 4663";

/** The first lines of a report: the bold title and subject, the chain on the right, and gray context under them. */
export function titleLines(title: string, subject: string, context: readonly string[], c: Palette, width: number | null): string[] {
  const inner = Math.min(width ?? 100, MAX_WIDTH) - 2;
  const left = subject ? `${c.bold(title)}   ${subject}` : c.bold(title);
  const fits = visibleLength(left) + 3 + CHAIN_LABEL.length <= inner;
  const where = [...context, ...(fits ? [] : [CHAIN_LABEL])];
  return ["", `  ${fits ? spread(left, c.gray(CHAIN_LABEL), inner) : left}`, ...(where.length > 0 ? joinFit(where, width, "  ").map((line) => c.gray(line)) : [])];
}

export interface Fact {
  label: string;
  value: string;
  /** What the value rests on or means, in gray under it. */
  note?: string | null;
}

/** Label, value and note, each value and note wrapped under itself. */
export function factLines(facts: readonly Fact[], c: Palette, width: number | null, labelWidth = 20): string[] {
  const indent = " ".repeat(2 + labelWidth);
  const lines: string[] = [];
  for (const fact of facts) {
    const value = wrap(fact.value, width, indent);
    value[0] = `  ${padEnd(fact.label, labelWidth)}${value[0]!.slice(indent.length)}`;
    lines.push(...value);
    if (fact.note) lines.push(...wrap(fact.note, width, indent).map((line) => c.gray(line)));
  }
  return lines;
}

/** A bold section heading with gray context after it. */
export function headingLine(text: string, context: string | null, c: Palette): string {
  return context ? `  ${c.bold(text)}   ${c.gray(context)}` : `  ${c.bold(text)}`;
}

/** Prose, wrapped with the report's indent. */
export function paragraph(text: string, width: number | null, style: (text: string) => string = (t) => t): string[] {
  return wrap(text, width, "  ").map((line) => style(line));
}

/**
 * Rows as a table, each column as wide as its widest cell. The last column is not padded, so a long value (an
 * address) does not push trailing spaces.
 */
export function tableLines(head: readonly string[], rows: readonly (readonly string[])[], c: Palette): string[] {
  const widths = head.map((title, i) => Math.max(visibleLength(title), ...rows.map((row) => visibleLength(row[i] ?? ""))));
  const line = (cells: readonly string[]) =>
    `  ${cells.map((cell, i) => (i === cells.length - 1 ? cell : padEnd(cell, (widths[i] ?? 0) + 3))).join("")}`.trimEnd();
  return [c.gray(line(head)), ...rows.map(line)];
}

/** The widest a table row would be, for choosing between full and short addresses. */
export function tableWidth(head: readonly string[], rows: readonly (readonly string[])[]): number {
  const widths = head.map((title, i) => Math.max(visibleLength(title), ...rows.map((row) => visibleLength(row[i] ?? ""))));
  return 2 + widths.reduce((sum, w, i) => sum + w + (i === widths.length - 1 ? 0 : 3), 0);
}
