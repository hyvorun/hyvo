// What `hyvo watch` compares between two checks of one token. A check that could not look (`skipped`) never
// counts as a change: the last status that was read stands until a new one is read.

import { CHECKS, formatAmount, shortenAddress, type CheckId, type CheckReport, type FindingStatus } from "@hyvo/check";
import { STATUS_LABEL, venueLabel } from "./format/check.js";

export interface Known {
  /** The last status read for each check, `skipped` aside. */
  statuses: Partial<Record<CheckId, FindingStatus>>;
  owner?: string | null;
  implementation?: string | null;
  totalSupply?: bigint;
  venue?: string;
}

export interface Change {
  /** A check's title, or what changed. */
  what: string;
  from: string;
  to: string;
  /** The new evidence, for a check whose status changed. */
  evidence?: string;
}

const short = (address: string | null): string => (address ? shortenAddress(address) : "none");

/** Folds a new report into what is known, and returns what changed. The first report changes nothing. */
export function observe(known: Known | null, report: CheckReport): { known: Known; changes: Change[] } {
  const next: Known = { statuses: { ...(known?.statuses ?? {}) } };
  const changes: Change[] = [];
  const status = (id: CheckId): FindingStatus | undefined => report.findings.find((f) => f.id === id)?.status;

  for (const finding of report.findings) {
    if (finding.status === "skipped") continue;
    const before = known?.statuses[finding.id];
    next.statuses[finding.id] = finding.status;
    if (known && before !== finding.status && (before !== undefined || finding.status === "found")) {
      changes.push({
        what: CHECKS[finding.id].title,
        from: before === undefined ? "not read before" : STATUS_LABEL[before],
        to: STATUS_LABEL[finding.status],
        evidence: finding.evidence,
      });
    }
  }

  const track = <K extends "owner" | "implementation">(key: K, check: CheckId, value: string | null, what: string): void => {
    next[key] = known?.[key];
    if (status(check) === "skipped") return;
    if (known && known[key] !== undefined && known[key] !== value) changes.push({ what, from: short(known[key] ?? null), to: short(value) });
    next[key] = value;
  };
  track("owner", "owner", report.code.owner, "Owner address");
  track("implementation", "proxy", report.code.proxyImplementation, "Proxy implementation");

  next.totalSupply = known?.totalSupply;
  const supply = report.token.totalSupply;
  if (supply !== null) {
    if (known?.totalSupply !== undefined && known.totalSupply !== supply) {
      const decimals = report.token.decimals ?? 18;
      changes.push({ what: "Total supply", from: formatAmount(known.totalSupply, decimals), to: formatAmount(supply, decimals) });
    }
    next.totalSupply = supply;
  }

  next.venue = known?.venue;
  if (report.exit) {
    const venue = venueLabel(report.exit.venue);
    if (known?.venue !== undefined && known.venue !== venue) changes.push({ what: "Trading venue", from: known.venue, to: venue });
    next.venue = venue;
  }

  return { known: next, changes };
}

export function countStatuses(report: CheckReport): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = { found: 0, not_found: 0, skipped: 0 };
  for (const f of report.findings) counts[f.status]++;
  return counts;
}
