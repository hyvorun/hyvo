// Hyvo's copy rules, enforced in code. A report states facts with evidence; it never gives a verdict about a
// token, never advises anyone to trade, and never predicts a price. These words never appear in Hyvo Check's own
// text, and text that comes from a contract (a revert message) has them masked before it is quoted.

const BANNED = /\b(safe|safely|safety|scams?|scammy|rugs?|rugged|rug ?pulls?|honey ?pots?|legit(imate)?|guarantee[ds]?|will pump|good token|bad token)\b/gi;

/** True when `text` contains a word Hyvo never uses about a token. */
export function hasBannedWords(text: string): boolean {
  BANNED.lastIndex = 0;
  const found = BANNED.test(text);
  BANNED.lastIndex = 0;
  return found;
}

/**
 * Text written by a contract's author (a revert message), made fit to quote as evidence: control characters
 * dropped, length capped, and any banned word masked, so a contract cannot put a verdict into a report.
 */
export function quoteThirdParty(text: string, max = 96): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  out = out.trim().replace(BANNED, "[…]");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
