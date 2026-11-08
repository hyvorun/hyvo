import type { RunV1 } from "@hyvo/schema";
import { useState } from "react";
import { Link } from "react-router";
import { fetchArtifactLink } from "../lib/api";
import { modelLabel, personaLabel } from "../lib/format";
import styles from "./RunProvenance.module.css";

/** What each copy rule catches, for the sentence about a report line that broke it. */
const RULES: Record<string, string> = {
  guaranteed: "a promise or a guarantee",
  will_pump: "a claim that the price would shoot up",
  good_token: "a verdict on the token",
  bad_token: "a verdict on the token",
  advice_modal: "trading advice",
  advice_imperative: "trading advice",
  advice_noun: "trading advice",
  time_to: "trading advice",
  price_prediction: "a price prediction",
};

const SOURCES = {
  user: "Written by whoever asked for the run",
  url: "A web page",
  onchain: "Read from the chain",
} as const;

/** ", about $0.033 of compute"; nothing for a run that cost nothing, such as one on the offline model. */
function costText(usd: number): string {
  if (usd <= 0) return "";
  if (usd < 0.001) return ", less than $0.001 of compute";
  return `, about $${usd.toFixed(usd < 1 ? 3 : 2)} of compute`;
}

/** "Panic sellers" -> "panic sellers", but "KOL followers" stays. */
function lowerFirst(label: string): string {
  return /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** One sentence per flag the engine left on the report; an unknown flag is shown as it is. */
export function flagSentences(flags: string[]): { key: string; text: string; raw: boolean }[] {
  return flags.map((flag) => {
    const [name = "", detail = ""] = flag.split(":");
    if (name === "posts_removed") {
      const count = Number(detail);
      return { key: flag, raw: false, text: `${count} ${count === 1 ? "post was" : "posts were"} taken out for breaking the copy rules; the feed shows where.` };
    }
    if (name === "post_review_incomplete") return { key: flag, raw: false, text: "The review of the posts did not reach every post." };
    if (name === "question_incomplete") return { key: flag, raw: false, text: "Not every agent answered the run's question." };
    if (name === "rewritten") return { key: flag, raw: false, text: `A line of the report was rewritten because it read as ${RULES[detail] ?? "breaking a copy rule"}.` };
    if (name === "redacted") return { key: flag, raw: false, text: `A sentence was taken out of the report because it read as ${RULES[detail] ?? "breaking a copy rule"}.` };
    return { key: flag, raw: true, text: flag };
  });
}

/** Where a run came from: what the crowd read, which models played it, what it cost, and what the copy guard took out. */
export function RunProvenance({ run }: { run: RunV1 }) {
  const [link, setLink] = useState<{ status: "idle" | "loading" | "error" } | { status: "ready"; url: string }>({ status: "idle" });
  // The link is signed for a few minutes, so it is made when the section opens rather than with the page.
  const makeLink = () => {
    setLink({ status: "loading" });
    fetchArtifactLink(run.runId).then(
      ({ url }) => setLink({ status: "ready", url }),
      () => setLink({ status: "error" }),
    );
  };
  const flags = flagSentences(run.report.flags);
  const pool = run.world.pools[0];
  const mix = Object.entries(run.crowd.personaMix).filter(([, count]) => (count ?? 0) > 0) as [string, number][];

  return (
    <details className={styles.provenance} onToggle={(event) => event.currentTarget.open && link.status === "idle" && makeLink()}>
      <summary>How this run was made</summary>
      <dl>
        <div>
          <dt>What the crowd read</dt>
          <dd>
            {run.scenario.seedSources.length === 0 ? (
              <span>The scenario above, and nothing else.</span>
            ) : (
              <ul>
                {run.scenario.seedSources.map((source) => (
                  <li key={`${source.kind}-${source.ref}`}>
                    {SOURCES[source.kind]}
                    {source.ref && (
                      <>
                        : <span className="mono">{source.ref}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>The crowd</dt>
          <dd>
            <span>
              {mix.map(([persona, count]) => `${count} ${lowerFirst(personaLabel(persona, count))}`).join(", ")}, with generated handles.
            </span>
          </dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>
            <span>
              Agents: <span className="mono">{modelLabel(run.crowd.model.agents)}</span>. Report: <span className="mono">{modelLabel(run.crowd.model.report)}</span>.
              Temperature <span className="num">{run.crowd.model.temperature}</span>.
            </span>
          </dd>
        </div>
        <div>
          <dt>Work done</dt>
          <dd>
            <span className="num">
              {run.usage.llmCalls.toLocaleString("en-US")} model calls, {run.usage.inputTokens.toLocaleString("en-US")} tokens read and{" "}
              {run.usage.outputTokens.toLocaleString("en-US")} written{costText(run.usage.costUsd)}.
            </span>
          </dd>
        </div>
        {pool && (
          <div>
            <dt>The market</dt>
            <dd>
              <span>
                {pool.kind === "real" ? "A real pool, as it stood at the fork block" : "A test pool deployed on the fork for this run"}, trading{" "}
                {run.world.token.symbol} against {run.world.quote.symbol} with a <span className="num">{pool.feeBps / 100}%</span> fee.{" "}
                {run.world.initialMarket.holders.toLocaleString("en-US")} wallets held the token before round 1.
              </span>
            </dd>
          </div>
        )}
        <div>
          <dt>Copy guard</dt>
          <dd>
            {flags.length === 0 ? (
              <span>Nothing was taken out or rewritten.</span>
            ) : (
              <ul>
                {flags.map((flag) => (
                  <li key={flag.key} className={flag.raw ? "mono" : undefined}>
                    {flag.text}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>The file</dt>
          <dd className={styles.file}>
            {link.status === "ready" ? (
              <a href={link.url} target="_blank" rel="noreferrer">
                Open the exact run.json
              </a>
            ) : link.status === "error" ? (
              <button type="button" onClick={makeLink}>
                The link could not be made. Try again
              </button>
            ) : (
              <span>Making a link to the file…</span>
            )}
            <span>The link works for 15 minutes. Its hash is the one checked above and committed on-chain.</span>
            <Link to={`/oracle?run=${encodeURIComponent(run.runId)}`}>Check it on the oracle</Link>
          </dd>
        </div>
      </dl>
    </details>
  );
}
