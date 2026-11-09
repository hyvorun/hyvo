// What the package promises, checked on its source text: Hyvo's copy rules, read-only, and what npm would ship.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasBannedWords } from "../../check/src/output/copy";
import { HELP } from "../src/cli";
import { ORACLE } from "../src/oracle";

const pkgDir = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(pkgDir, path), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function stringLiterals(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return [...code.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g)].map((m) => m[0]);
}

describe("copy rules", () => {
  it("no string in the CLI uses a word Hyvo never uses about a token", () => {
    for (const file of sourceFiles(join(pkgDir, "src"))) {
      for (const literal of stringLiterals(readFileSync(file, "utf8"))) expect(hasBannedWords(literal), `${file}: ${literal}`).toBe(false);
    }
  });

  it("the README neither", () => {
    expect(hasBannedWords(read("README.md"))).toBe(false);
  });

  it("every result surface names its disclaimer", () => {
    expect(HELP).toContain("not a trading signal");
    const readme = read("README.md");
    expect(readme).toContain("Measured on-chain at block N. Not a trading signal.");
    expect(readme).toContain("Synthetic crowd reaction. Not a trading signal.");
  });
});

describe("read-only", () => {
  it("has no code that signs or sends a transaction", () => {
    for (const file of sourceFiles(join(pkgDir, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const call of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTypedData", "privateKey", "mnemonic"]) {
        expect(text.includes(call), `${file}: ${call}`).toBe(false);
      }
    }
  });

  it("pins the oracle from the repository's deployment record", () => {
    const deployment = JSON.parse(readFileSync(new URL("../../../chain/deployments/4663.json", import.meta.url), "utf8")) as { oracle: string; chainId: number };
    expect(ORACLE.address).toBe(deployment.oracle);
    expect(ORACLE.chainId).toBe(4663);
  });
});

describe("the npm package", () => {
  const pkg = JSON.parse(read("package.json")) as Record<string, any>;

  it("is @hyvo/cli, AGPL-3.0-or-later, with one binary named hyvo", () => {
    expect(pkg.name).toBe("@hyvo/cli");
    expect(pkg.license).toBe("AGPL-3.0-or-later");
    expect(pkg.bin).toEqual({ hyvo: "dist/index.js" });
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]);
  });

  it("installs nothing else: what it needs is bundled into dist", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("ships the repository's license text", () => {
    expect(read("LICENSE")).toBe(readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8"));
    expect(read("LICENSE")).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
  });

  it("documents every command", () => {
    const readme = read("README.md");
    for (const command of ["check", "watch", "watchlist", "runs", "verify", "mcp", "config"]) expect(readme, command).toContain(`hyvo ${command}`);
    expect(readme).toContain("npx @hyvo/cli check 0x");
  });

  it("names Aleph's MIT notice and every bundled package in its third-party notices", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("Copyright (c) 2026 Aleph");
    for (const name of ["zod", "@noble/hashes", "canonicalize"]) expect(notices, name).toContain(name);
  });
});
