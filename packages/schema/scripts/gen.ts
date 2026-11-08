/**
 * Writes run.schema.json from the zod schema and the summary vectors the Python engine is held to.
 * Run with `pnpm --filter @hyvo/schema gen`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { summarizeRun } from "../src/summary";
import { buildRunJsonSchema } from "./run-schema";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

const target = path("../run.schema.json");
writeFileSync(target, `${JSON.stringify(buildRunJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target}`);

for (const [source, vector] of [
  ["../test-vectors/sample-run.json", "../test-vectors/sample-run.summary.json"],
  ["../../../fixtures/golden-run.json", "../test-vectors/golden-run.summary.json"],
] as const) {
  const run = JSON.parse(readFileSync(path(source), "utf8"));
  writeFileSync(path(vector), `${JSON.stringify(summarizeRun(run), null, 2)}\n`);
  console.log(`wrote ${path(vector)}`);
}
