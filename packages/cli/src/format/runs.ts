import type { RunListResponse } from "@hyvo/schema";
import type { Palette } from "../color.js";
import { RUN_DISCLAIMER } from "../verify.js";
import { oneLine, wrap } from "./text.js";

export function renderRuns(list: RunListResponse, c: Palette, apiHost: string, width: number | null): string {
  const lines = ["", `  ${c.bold("HYVO RUNS")}   ${c.gray(`published, newest first · ${apiHost}`)}`, ""];
  if (list.runs.length === 0) lines.push(`  ${c.gray("No published runs yet.")}`, "");
  for (const run of list.runs) {
    const m = run.market;
    const sign = m.priceChangePct > 0 ? "+" : "";
    lines.push(`  ${c.bold(run.runId)}   ${c.gray(`published ${run.publishedAt.replace("T", " ").replace("Z", " UTC")} · ${run.status}${run.stopReason ? ` (${run.stopReason})` : ""}`)}`);
    lines.push(...wrap(oneLine(run.title, 200), width, "  "));
    lines.push(
      ...wrap(
        `${run.crowdSize} agents · ${run.rounds} rounds · simulated ${oneLine(m.symbol, 16)} price ${m.priceStart} → ${m.priceEnd} (${sign}${m.priceChangePct}%) · ${m.swaps} swaps · ${m.posts} posts`,
        width,
        "  ",
      ).map((line) => c.gray(line)),
    );
    if (run.question) {
      const q = run.question;
      lines.push(...wrap(`asked: ${oneLine(q.text, 300)} · yes ${q.yes}, no ${q.no}, unsure ${q.unsure}`, width, "  ").map((line) => c.gray(line)));
    }
    lines.push(`  ${c.gray(`hash ${run.hash}`)}`, "");
  }
  if (list.nextCursor) lines.push(`  ${c.gray(`More: hyvo runs --cursor ${list.nextCursor}`)}`);
  lines.push(`  ${c.gray("Check one against the chain: hyvo verify <runId>")}`, `  ${RUN_DISCLAIMER}`, "");
  return lines.join("\n");
}
