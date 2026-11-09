import { visibleLength } from "../color.js";

/** The widest a report is laid out, even on a wide terminal: long lines are hard to read. */
export const MAX_WIDTH = 110;

/**
 * Word-wraps `text` so no line passes `width` columns, every line starting with `indent`. A null width (output
 * that is not a terminal) keeps the text on one line, so it stays easy to grep.
 */
export function wrap(text: string, width: number | null, indent: string): string[] {
  if (width === null) return [indent + text];
  const room = Math.max(20, Math.min(width, MAX_WIDTH) - indent.length);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && visibleLength(line) + 1 + visibleLength(word) > room) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.length > 0 ? lines : [indent];
}

/** Joins `parts` with `sep`, starting a new line (with `indent`) where the next part would pass `width`. */
export function joinFit(parts: readonly string[], width: number | null, indent: string, sep = " · "): string[] {
  if (width === null) return [indent + parts.join(sep)];
  const room = Math.min(width, MAX_WIDTH) - indent.length;
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    if (line && visibleLength(line) + sep.length + visibleLength(part) > room) {
      lines.push(indent + line);
      line = part;
    } else {
      line = line ? line + sep + part : part;
    }
  }
  lines.push(indent + line);
  return lines;
}

/** Pads to `width` visible columns, so styled text lines up. */
export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

/** `left`, spaces, `right`, together `width` columns wide (at least one space between). */
export function spread(left: string, right: string, width: number): string {
  return left + " ".repeat(Math.max(1, width - visibleLength(left) - visibleLength(right))) + right;
}

/** Text from a token or a server, made fit for one terminal line: no control characters, at most `max` long. */
export function oneLine(text: string, max = 80): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** A unix time in seconds as `2026-11-06 03:24:26 UTC`. */
export function utc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
