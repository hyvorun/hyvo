// Everything a command touches outside itself, in one object, so tests can hand it a fake terminal, a fake
// network and a fake clock. `nodeContext()` is the real one.

import { checkToken } from "@hyvo/check";
import { colorEnabled, makePalette, type Palette } from "./color.js";
import { configDir } from "./config.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Context {
  out(text: string): void;
  err(text: string): void;
  env: Env;
  /** Styling for stdout; plain when stdout is not a terminal or NO_COLOR is set. */
  palette: Palette;
  /** The terminal's width, or null when stdout is not a terminal (output is then not wrapped). */
  columns: number | null;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  configDir: string;
  /** A signal aborted by Ctrl+C. Only `hyvo watch` asks for it; other commands keep Node's default of exiting. */
  interrupt(): AbortSignal;
  /** Lines from stdin, for `hyvo mcp`. */
  stdinLines(): AsyncIterable<string>;
  checkToken: typeof checkToken;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function nodeContext(): Context {
  const env = process.env;
  const isTTY = Boolean(process.stdout.isTTY);
  let interrupt: AbortController | null = null;
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    env,
    palette: makePalette(colorEnabled(env, isTTY)),
    columns: isTTY ? (process.stdout.columns ?? 100) : null,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep,
    configDir: configDir(env),
    interrupt() {
      if (!interrupt) {
        const controller = new AbortController();
        interrupt = controller;
        process.once("SIGINT", () => controller.abort());
      }
      return interrupt.signal;
    },
    async *stdinLines() {
      process.stdin.setEncoding("utf8");
      let buffer = "";
      for await (const chunk of process.stdin) {
        buffer += String(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          yield buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) yield buffer;
    },
    checkToken,
  };
}
