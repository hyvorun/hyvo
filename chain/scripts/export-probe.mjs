// Exports the SellCheck probe's ABI and runtime bytecode from Foundry's build output
// (out/SellCheck.sol/SellCheck.json) to packages/check/src/probe/sellcheck.json, which Hyvo Check places at a
// throwaway address inside one eth_call. The probe is never deployed, so only the runtime code is kept.
//
// Usage, from chain/: forge build && node scripts/export-probe.mjs

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const chainDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(chainDir, "..");
const sourcePath = join(chainDir, "src", "probes", "SellCheck.sol");
const buildPath = join(chainDir, "out", "SellCheck.sol", "SellCheck.json");
const targetPath = join(repoDir, "packages", "check", "src", "probe", "sellcheck.json");

let output;
try {
  output = JSON.parse(await readFile(buildPath, "utf8"));
} catch (error) {
  throw new Error(`Cannot read ${relative(chainDir, buildPath)}; run \`forge build\` first. (${error.message})`);
}

const runtime = output.deployedBytecode?.object;
if (typeof runtime !== "string" || !/^0x([0-9a-f]{2})+$/i.test(runtime)) {
  throw new Error("SellCheck: missing or unlinked runtime bytecode in the build output");
}
if (!Array.isArray(output.abi)) throw new Error("SellCheck: missing ABI in the build output");

// Line endings are normalized so a Windows checkout and a Linux checkout hash the same text.
const source = (await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n");
const settings = output.metadata?.settings ?? {};
const probe = {
  contractName: "SellCheck",
  source: "chain/src/probes/SellCheck.sol",
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  compiler: output.metadata?.compiler?.version ?? null,
  evmVersion: settings.evmVersion ?? null,
  optimizer: settings.optimizer ?? null,
  abi: output.abi,
  runtimeBytecode: runtime.toLowerCase(),
};

await mkdir(dirname(targetPath), { recursive: true });
await writeFile(targetPath, `${JSON.stringify(probe, null, 2)}\n`);
console.log(`wrote ${relative(repoDir, targetPath)} (${(runtime.length - 2) / 2} bytes of runtime code)`);
