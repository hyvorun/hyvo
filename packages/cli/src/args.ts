// A small, strict argument parser. Each command declares its options, so a boolean option never swallows the
// argument after it (`hyvo check --json 0x…` reads the address), and an unknown option is an error instead of a
// silent no-op.

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export type OptionSpec = Record<string, { type: "boolean" | "string"; short?: string }>;

export interface ParsedArgs {
  positional: string[];
  /** Booleans are `true` when given; strings hold the last value given. Options not given are absent. */
  options: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[], spec: OptionSpec): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  const byShort = new Map(Object.entries(spec).flatMap(([name, s]) => (s.short ? [[s.short, name] as const] : [])));

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    } else if (/^-[A-Za-z]$/.test(arg)) {
      const long = byShort.get(arg.slice(1));
      if (!long) throw new UsageError(`unknown option ${arg}`);
      name = long;
    } else {
      positional.push(arg);
      continue;
    }

    const option = spec[name];
    if (!option) throw new UsageError(`unknown option --${name}`);
    if (option.type === "boolean") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      options[name] = true;
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
    if (inline === undefined) i++;
    options[name] = value;
  }
  return { positional, options };
}

/** A whole number in [min, max], or a UsageError naming the option. */
export function intOption(value: string | boolean | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new UsageError(`--${name} must be a whole number, not ${text}`);
  const n = Number(text);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}

export function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** At most `max` positional arguments, with a usage error naming the first extra one. */
export function noExtra(positional: readonly string[], max: number): void {
  if (positional.length > max) throw new UsageError(`unexpected argument: ${positional[max]}`);
}
