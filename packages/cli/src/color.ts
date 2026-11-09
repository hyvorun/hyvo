// Terminal styling without a dependency. NO_COLOR (https://no-color.org) and output that is not a terminal turn it
// off; FORCE_COLOR turns it on. Status is shown in weight and shade, never in red and green, because a check
// states facts and gives no verdict. Red and green appear only where a hash matches or does not.

export interface Palette {
  bold(text: string): string;
  dim(text: string): string;
  gray(text: string): string;
  green(text: string): string;
  red(text: string): string;
}

export function colorEnabled(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0" && force.toLowerCase() !== "false";
  return isTTY;
}

const wrap =
  (open: number, close: number) =>
  (text: string): string =>
    `\u001b[${open}m${text}\u001b[${close}m`;

const plain = (text: string): string => text;

export function makePalette(enabled: boolean): Palette {
  if (!enabled) return { bold: plain, dim: plain, gray: plain, green: plain, red: plain };
  return { bold: wrap(1, 22), dim: wrap(2, 22), gray: wrap(90, 39), green: wrap(32, 39), red: wrap(31, 39) };
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Length as the terminal shows it: escape codes take no room. */
export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
