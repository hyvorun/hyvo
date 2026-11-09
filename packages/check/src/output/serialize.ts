import type { CheckReport } from "../types.js";

/** A value with every bigint turned into its decimal string, as JSON carries it. */
export type Jsonified<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T;

export type JsonCheckReport = Jsonified<CheckReport>;

function convert(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
  }
  return value;
}

/** The report with bigints as decimal strings, ready for JSON.stringify. */
export function serializeReport(report: CheckReport): JsonCheckReport {
  return convert(report) as JsonCheckReport;
}
