import { z } from "zod";
import { RunV1 } from "../src/run";

/**
 * JSON Schema (draft 2020-12) for run.json v1, generated from `RunV1`. Refinements that span
 * several fields have no JSON Schema form and are left out.
 */
export function buildRunJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(RunV1, { target: "draft-2020-12" });
  return {
    $schema,
    title: "Hyvo run.json v1",
    description:
      "Generated from RunV1 in packages/schema (pnpm --filter @hyvo/schema gen); the format is " +
      "docs/RUN_FORMAT.md. Covers the per-field rules only: cross-field rules (sums, references, " +
      "one action per agent per round, action consistency) are checked by RunV1 itself.",
    ...schema,
  };
}
