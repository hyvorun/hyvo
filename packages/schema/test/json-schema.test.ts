import { describe, expect, it } from "vitest";
import { buildRunJsonSchema } from "../scripts/run-schema";
import { readPackageFile } from "./fixtures";

type Node = Record<string, unknown>;

const committed = JSON.parse(readPackageFile("run.schema.json")) as Node;

/** Every object node in a JSON Schema document. */
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== "object") return [];
  return [value as Node, ...Object.values(value).flatMap(nodes)];
}

describe("run.schema.json", () => {
  it("is up to date with RunV1 (regenerate with `pnpm --filter @hyvo/schema gen`)", () => {
    expect(committed).toEqual(buildRunJsonSchema());
  });

  it("is draft 2020-12 and requires every top-level member", () => {
    expect(committed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(committed.required).toEqual([
      "runId", "version", "createdAt", "status", "stopReason", "scenario",
      "world", "crowd", "rounds", "report", "usage", "hash",
    ]);
  });

  it("rejects unknown keys in every object", () => {
    const objects = nodes(committed).filter((node) => node.type === "object");
    expect(objects.length).toBeGreaterThan(15);
    for (const object of objects) {
      // A map (question.byAgent) names its keys with a pattern instead, and types its values.
      if (object.propertyNames) expect(object.additionalProperties).toBeTypeOf("object");
      else expect(object.additionalProperties).toBe(false);
    }
  });

  it("spells digits as [0-9] in every pattern, so Python re and JavaScript agree", () => {
    const patterns = nodes(committed).flatMap((node) => (typeof node.pattern === "string" ? [node.pattern] : []));
    expect(patterns.length).toBeGreaterThan(5);
    for (const pattern of patterns) expect(pattern).not.toContain("\\d");
  });

  it("states text limits as code-point lengths", () => {
    const scenario = (committed.properties as Record<string, Node>).scenario!;
    const title = (scenario.properties as Record<string, Node>).title;
    expect(title).toEqual({ type: "string", minLength: 1, maxLength: 200 });
  });
});
