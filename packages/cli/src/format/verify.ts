import { shortenAddress } from "@hyvo/check";
import type { Palette } from "../color.js";
import type { VerifyReport } from "../verify.js";
import { padEnd, utc, wrap } from "./text.js";

const LABEL_WIDTH = 11;
const INDENT = " ".repeat(2 + LABEL_WIDTH);

function mark(ok: boolean | null, c: Palette, missing = "missing"): string {
  if (ok === null) return c.red(missing);
  return ok ? c.green("match") : c.red("mismatch");
}

export function verifyReason(report: VerifyReport): string {
  if (!report.file.matches) return "the file does not hash to the hash it records";
  if (!report.chain.commit) return "Robinhood Chain holds no commit for this run id";
  if (!report.chain.reportHashMatches) return "the chain holds another hash for this run";
  return "the chain holds another scenario hash for this run";
}

export function renderVerify(report: VerifyReport, c: Palette, width: number | null): string {
  const { file, chain, api } = report;
  const lines = ["", `  ${c.bold("HYVO VERIFY")}   ${report.runId}`];
  if (report.title) lines.push(`  ${report.title}`);
  lines.push("");

  lines.push(`  ${padEnd(mark(file.matches, c), LABEL_WIDTH)}run.json hashes to the hash it records`);
  lines.push(`${INDENT}${c.gray(file.recomputed)}`);
  if (!file.matches) lines.push(`${INDENT}${c.gray(`the file records ${file.hash ?? "no hash"}`)}`);

  if (chain.commit) {
    lines.push(`  ${padEnd(mark(chain.reportHashMatches, c), LABEL_WIDTH)}reportHash on chain is that hash`);
    lines.push(`${INDENT}${c.gray(chain.commit.reportHash)}`);
    lines.push(`  ${padEnd(mark(chain.scenarioHashMatches, c), LABEL_WIDTH)}scenarioHash on chain is the scenario's hash`);
    lines.push(`${INDENT}${c.gray(chain.commit.scenarioHash)}`);
    if (!chain.scenarioHashMatches) lines.push(`${INDENT}${c.gray(`the scenario hashes to ${file.scenarioHash ?? "nothing: the file has no scenario"}`)}`);
    lines.push(`${INDENT}${c.gray(`committed ${utc(chain.commit.committedAt)}, by the block's own clock`)}`);
  } else {
    lines.push(`  ${padEnd(mark(null, c), LABEL_WIDTH)}no commit for this run id in HyvoOracle`);
  }
  const oracleLine = `HyvoOracle ${chain.oracle} on Robinhood Chain (${chain.chainId}), read through ${chain.rpc} at the latest block${
    chain.oracleFrom === "pinned" ? "" : " (the address you gave)"
  }`;
  lines.push(...wrap(oracleLine, width, INDENT).map((line) => c.gray(line)));

  lines.push("");
  lines.push(report.verified ? `  ${c.green(c.bold("Verified."))} This run.json is the one committed on Robinhood Chain.` : `  ${c.red(c.bold("Not verified:"))} ${verifyReason(report)}.`);

  const notes: string[] = [];
  if (file.source === "file") notes.push(`run.json read from ${file.path}; the API was not asked.`);
  if (api) {
    const where = api.txHash ? ` The API records the commit in transaction ${api.txHash}${api.blockNumber !== null ? `, block ${api.blockNumber}` : ""}.` : "";
    notes.push(`run.json downloaded from ${api.host}.${where}`);
    if (api.oracleAddress && api.oracleAddress.toLowerCase() !== chain.oracle.toLowerCase()) {
      notes.push(`The API names another oracle, ${api.oracleAddress}; this check read ${shortenAddress(chain.oracle)}${chain.oracleFrom === "pinned" ? ", the one this build pins" : ""}.`);
    }
  }
  if (notes.length > 0) lines.push("", ...notes.flatMap((note) => wrap(note, width, "  ").map((line) => c.gray(line))));
  lines.push("", `  ${report.disclaimer}`, "");
  return lines.join("\n");
}
