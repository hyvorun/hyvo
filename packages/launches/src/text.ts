/**
 * Names and symbols are typed by whoever launched the token, so they are untrusted. This keeps what
 * can be read and drops what can hide, spoof or reorder text: control characters, bidirectional
 * overrides and isolates, zero-width and filler characters. It also limits stacked combining marks,
 * folds whitespace and caps the length. Rendering still escapes the result (React does).
 */
export const SYMBOL_MAX = 24;
export const NAME_MAX = 64;

const INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space, joiners and directional marks
  [0x2028, 0x202e], // line and paragraph separators, bidirectional embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators and bidirectional isolates
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff9, 0xfffb], // interlinear annotation characters
];

const fromCode = (code: number) => String.fromCharCode(code);
// Built from code points, so no tool can alter an escape sequence in the source.
const INVISIBLE_RE = new RegExp(`[${INVISIBLE.map(([a, b]) => (a === b ? fromCode(a) : `${fromCode(a)}-${fromCode(b)}`)).join("")}]`, "g");
// Line breaks, tabs and the Unicode line and paragraph separators read as one space.
const BREAKS = new RegExp(`[\t\n\v\f\r${fromCode(0x2028)}${fromCode(0x2029)}]+`, "g");
const TAGS_RE = /[\u{E0000}-\u{E007F}]/gu; // tag characters, invisible
const EXCESS_MARKS = /(\p{M}{2})\p{M}+/gu;
const SPACE = /\s+/g;

/** Display-safe text, or null when nothing readable is left. */
export function cleanText(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  const text = input
    .normalize("NFC")
    .replace(BREAKS, " ")
    .replace(INVISIBLE_RE, "")
    .replace(TAGS_RE, "")
    .replace(EXCESS_MARKS, "$1")
    .replace(SPACE, " ")
    .trim();
  if (!text || !/[\p{L}\p{N}\p{S}\p{P}]/u.test(text)) return null;
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

export function cleanSymbol(input: unknown): string | null {
  return cleanText(input, SYMBOL_MAX);
}

export function cleanName(input: unknown): string | null {
  return cleanText(input, NAME_MAX);
}

/** The name, or null when it only repeats the symbol. */
export function distinctName(name: string | null, symbol: string | null): string | null {
  if (!name) return null;
  const key = (value: string | null) => (value ?? "").replace(/^\$+/, "").toLowerCase().replace(/\s+/g, "");
  return key(name) === key(symbol) ? null : name;
}
