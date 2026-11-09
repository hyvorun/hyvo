/**
 * The text edits the launch scripts make, as pure functions over a file's text: a JSON file keeps its key
 * order and its two-space layout, and README.md changes only between its hyvo-token markers.
 */

export const README_START = "<!-- hyvo-token:start -->";
export const README_END = "<!-- hyvo-token:end -->";

function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** A flat JSON object's text with `updates` applied: existing keys keep their place, new keys go last. */
export function patchJson(text: string, updates: Record<string, string | number>): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  for (const [key, next] of Object.entries(updates)) value[key] = next;
  const newline = eol(text);
  return `${JSON.stringify(value, null, 2).split("\n").join(newline)}${newline}`;
}

export type MarkerResult = { ok: true; text: string; before: string } | { ok: false; reason: string };

/**
 * Replace what lies between the start and end marker lines with `body`. Each marker must be on its own line,
 * once, start before end. A Markdown heading that opens the old block is kept, so the block's place in the
 * README's outline does not change.
 */
export function replaceMarked(text: string, body: string, start = README_START, end = README_END): MarkerResult {
  const newline = eol(text);
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => (line.trim() === start ? [index] : []));
  const ends = lines.flatMap((line, index) => (line.trim() === end ? [index] : []));
  if (starts.length === 0 && ends.length === 0) return { ok: false, reason: `no ${start} and ${end} lines` };
  if (starts.length !== 1 || ends.length !== 1) return { ok: false, reason: `the markers must appear once each (found ${starts.length} and ${ends.length})` };
  const [from, to] = [starts[0]!, ends[0]!];
  if (from >= to) return { ok: false, reason: "the end marker comes before the start marker" };
  const old = lines.slice(from + 1, to);
  const heading = old.find((line) => line.trim() !== "");
  const keep = heading && /^#{1,6}\s/.test(heading.trim()) ? [heading, ""] : [];
  const replaced = [...lines.slice(0, from + 1), ...keep, ...body.split(/\r?\n/), ...lines.slice(to)];
  return { ok: true, text: replaced.join(newline), before: old.join("\n") };
}

/** The README text once HYVO is live: the official address, linked to the explorer, and the token page. */
export function liveReadmeBlock(token: string, explorer: string, site: string): string {
  return [
    `**HYVO is live on Robinhood Chain.** Its official address is [\`${token}\`](${explorer}/address/${token}), the one shown on`,
    `[hyvo.run/token](${site}/token). Holding it brings free runs, a discount and a place ahead in the queue. Another token`,
    "uses the name HYVO and Hyvo's tagline; it is not Hyvo's. Only the address on hyvo.run/token is.",
  ].join("\n");
}
