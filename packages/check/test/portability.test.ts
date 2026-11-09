// The package must run unchanged in browsers, Node 18+ and Cloudflare Workers, and its own words must follow
// Hyvo's copy rules. Both are checked on the source text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasBannedWords } from "../src/output/copy";
import { ADDRESSES, BURN_ADDRESSES, PONS_V2_HOOK_RECORDED, PROBE_ADDRESS, PROBE_CALLER } from "../src/registry/addresses";
import { toChecksumAddress } from "../src/chain/abi";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

// Comments may explain history; only code and string literals are checked.
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function stringLiterals(text: string): string[] {
  return [...withoutComments(text).matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g)].map((m) => m[0]);
}

describe("portability", () => {
  const files = sourceFiles(srcDir);

  it("imports no Node modules and touches no Node globals", () => {
    for (const file of files) {
      const code = withoutComments(readFileSync(file, "utf8"));
      expect(code, file).not.toMatch(/from\s+["']node:/);
      expect(code, file).not.toMatch(/\brequire\(/);
      expect(code, file).not.toMatch(/\b(Buffer|process|__dirname|__filename)\b/);
      expect(code, file).not.toMatch(/AbortSignal\.any/); // not in Node 18
    }
  });

  it("has no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe("copy rules in the source", () => {
  it("no string in the package uses a word Hyvo never uses about a token", () => {
    for (const file of sourceFiles(srcDir)) {
      for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
        expect(hasBannedWords(literal), `${file}: ${literal}`).toBe(false);
      }
    }
  });
});

describe("addresses", () => {
  it("are all checksummed", () => {
    const all = [
      ...Object.values(ADDRESSES).map((c) => c.address),
      ...BURN_ADDRESSES,
      PONS_V2_HOOK_RECORDED,
      PROBE_ADDRESS,
      PROBE_CALLER,
    ];
    for (const a of all) expect(toChecksumAddress(a), a).toBe(a);
  });

  it("each name its source", () => {
    for (const [name, c] of Object.entries(ADDRESSES)) expect(c.source.length, name).toBeGreaterThan(10);
  });
});
