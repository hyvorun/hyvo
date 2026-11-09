// Builds dist/: the `hyvo` binary and the chunks it loads on demand.
//
// tsc checks the types (`pnpm typecheck`); esbuild writes the JavaScript. A bundler is needed because @hyvo/check,
// @hyvo/launches, @hyvo/sdk, @hyvo/schema and @hyvo/stocks are private workspace packages that export TypeScript
// source, so the published package carries their compiled code inside dist/ and installs nothing else.
// THIRD_PARTY_NOTICES.md lists what is bundled and under which license.
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL(".", import.meta.url));
rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  format: "esm",
  platform: "node",
  target: "node20",
  // Readable output: anyone can read what the binary does.
  minify: false,
  legalComments: "eof",
  // viem loads isows (and through it ws) with a dynamic import, only to open a WebSocket. hyvo reads over HTTPS
  // and never opens one, so neither is bundled; the import is never reached.
  external: ["isows"],
  metafile: true,
  logLevel: "warning",
});

chmodSync(new URL("./dist/index.js", import.meta.url), 0o755);

// Every third-party package compiled into dist/ must have its license in THIRD_PARTY_NOTICES.md. A package counts
// when some of its code is in an output file; one that was read but left out entirely (tree-shaken) does not.
const notices = readFileSync(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
const bundled = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
    const match = input.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//);
    if (match && bytesInOutput > 0) bundled.add(match[1]);
  }
}
const missing = [...bundled].filter((name) => !notices.includes(`| ${name} |`));
if (missing.length > 0) {
  console.error(`THIRD_PARTY_NOTICES.md does not list ${missing.join(", ")}, which the build bundled. Add their licenses.`);
  process.exit(1);
}

const outputs = Object.entries(result.metafile.outputs).map(([file, out]) => `  ${file}  ${(out.bytes / 1024).toFixed(0)} KiB`);
console.log(`built (bundled: ${[...bundled].sort().join(", ")})\n${outputs.join("\n")}`);
