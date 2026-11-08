// Exports the ABI and creation bytecode of the test-asset contracts from Foundry's build output
// (out/<Name>.sol/<Name>.json) to artifacts/<Name>.json, which the engine loads to deploy its world.
//
// Usage, from chain/: forge build && node scripts/export-artifacts.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS = ["SampleVault", "TestToken", "TestWETH", "HyvoV2Pair", "HyvoV2Router", "TestStablecoin", "HyvoOracle", "PaymentRouter"];

const chainDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(chainDir, "out");
const artifactsDir = join(chainDir, "artifacts");

async function readBuildOutput(name) {
  const path = join(outDir, `${name}.sol`, `${name}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${relative(chainDir, path)}; run \`forge build\` first. (${error.message})`);
  }
}

function toArtifact(name, output) {
  const bytecode = output.bytecode?.object;
  // Unlinked library placeholders or an abstract contract would not deploy, so refuse them here.
  if (typeof bytecode !== "string" || !/^0x([0-9a-f]{2})+$/i.test(bytecode)) {
    throw new Error(`${name}: missing or unlinked creation bytecode in the build output`);
  }
  if (!Array.isArray(output.abi)) {
    throw new Error(`${name}: missing ABI in the build output`);
  }
  return { contractName: name, abi: output.abi, bytecode };
}

await mkdir(artifactsDir, { recursive: true });
for (const name of CONTRACTS) {
  const artifact = toArtifact(name, await readBuildOutput(name));
  const target = join(artifactsDir, `${name}.json`);
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote ${relative(chainDir, target)} (${(artifact.bytecode.length - 2) / 2} bytes of creation code)`);
}
