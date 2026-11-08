import { readFileSync } from "node:fs";
import type { RunV1 } from "../src/index";

export interface CanonicalCase {
  name: string;
  /** JSON text, parsed by each implementation's own JSON parser. */
  inputJson: string;
  canonical: string;
  keccak256: string;
}

export interface SampleMeta {
  hash: string;
  scenarioHash: string;
  runIdBytes32: string;
}

export function readPackageFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export const canonicalCases = JSON.parse(readPackageFile("test-vectors/canonical.json")) as CanonicalCase[];
export const sampleRunText = readPackageFile("test-vectors/sample-run.json");
export const sampleMeta = JSON.parse(readPackageFile("test-vectors/sample-run.meta.json")) as SampleMeta;

/** A fresh, mutable copy of test-vectors/sample-run.json. */
export function sampleRun(): RunV1 {
  return JSON.parse(sampleRunText) as RunV1;
}
