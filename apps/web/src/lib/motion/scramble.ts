/**
 * A hash or an address that decodes into place: while it resolves, the characters to the left of
 * the front are final and the rest are random hex. Separators (the 0x prefix's x, an ellipsis, an
 * underscore) never scramble, so the shape of the value is there from the first frame.
 */

const HEX = "0123456789abcdef";
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The alphabet a character scrambles through, or null when it stays as it is. */
function alphabetOf(char: string): string | null {
  if (/[0-9a-f]/.test(char)) return HEX;
  if (/[A-F]/.test(char)) return HEX.toUpperCase();
  if (/[G-Z]/.test(char)) return BASE32;
  return null;
}

/**
 * `text` at `progress` (0 to 1) of its decode. A character resolves once the front has passed it;
 * at 1 the text is exactly itself, and a scrambled character is never the final one, so the
 * moment a character settles can be seen.
 */
export function scrambleAt(text: string, progress: number, random: () => number = Math.random): string {
  if (progress >= 1) return text;
  const chars = [...text];
  const front = Math.max(0, progress) * chars.length;
  return chars
    .map((char, i) => {
      if (i < front) return char;
      const alphabet = alphabetOf(char);
      if (!alphabet) return char;
      let pick = alphabet[Math.floor(random() * alphabet.length) % alphabet.length]!;
      if (pick.toLowerCase() === char.toLowerCase()) pick = alphabet[(alphabet.indexOf(pick) + 1) % alphabet.length]!;
      return pick;
    })
    .join("");
}

/** True when `text` has anything to decode: at least four characters that scramble. */
export function canScramble(text: string): boolean {
  return [...text].filter((char) => alphabetOf(char) !== null).length >= 4;
}
