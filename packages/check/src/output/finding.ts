import type { CheckId, Finding, FindingStatus } from "../types.js";
import { hasBannedWords } from "./copy.js";

const STATUSES: readonly FindingStatus[] = ["found", "not_found", "skipped"];

/**
 * Builds a finding and enforces the invariants at construction time: evidence is never empty, titles stay
 * short, and neither carries a word from Hyvo's banned list. A finding that cannot be built here must not be
 * reported at all.
 */
export function makeFinding(input: { id: CheckId; title: string; status: FindingStatus; evidence: string }): Finding {
  const evidence = input.evidence?.trim() ?? "";
  if (evidence.length === 0) {
    throw new Error(
      `Finding "${input.id}" has no evidence. Every finding must carry concrete evidence (a function, an address, a number or a reason).`,
    );
  }
  if (input.title.length > 40) {
    throw new Error(`Finding "${input.id}" title exceeds 40 chars: "${input.title}"`);
  }
  if (!STATUSES.includes(input.status)) {
    throw new Error(`Finding "${input.id}" has an unknown status: ${String(input.status)}`);
  }
  if (hasBannedWords(input.title) || hasBannedWords(evidence)) {
    throw new Error(`Finding "${input.id}" uses a word Hyvo's copy rules forbid: "${input.title}: ${evidence}"`);
  }
  return { id: input.id, title: input.title, status: input.status, evidence };
}

/**
 * Defensive re-check before a report leaves the package. The invariants are enforced at construction, but the
 * output must never trust that they were.
 */
export function validateFindings(findings: readonly Finding[]): void {
  for (const f of findings) {
    if (!f.evidence || f.evidence.trim().length === 0) {
      throw new Error(`Finding "${f.id}" has empty evidence and must not be reported.`);
    }
    if (hasBannedWords(f.title) || hasBannedWords(f.evidence)) {
      throw new Error(`Finding "${f.id}" uses a word Hyvo's copy rules forbid.`);
    }
  }
}
