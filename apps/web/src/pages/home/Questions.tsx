import type { HealthResponse, RunV1 } from "@hyvo/schema";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Reveal } from "../../components/Reveal";
import { modelLabel } from "../../lib/format";
import { HYVO_TOKEN, ONLY_TOKEN } from "../../lib/official";
import styles from "./Briefs.module.css";
import shared from "./Section.module.css";

const SOURCE_URL = ((import.meta.env.VITE_SOURCE_URL as string | undefined) ?? "").trim();

/** The questions people ask first, answered from what the site and the chain can show. */
export function Questions({ run, features }: { run: RunV1 | null; features: HealthResponse["features"] | null }) {
  const items: { q: string; a: ReactNode }[] = [
    {
      q: "Is a run a prediction?",
      a: "No. The agents are language models playing archetypes, and a run is one sample of how such a crowd might react to a scenario on a private copy of the chain. The same scenario can play out differently the next time. Results are synthetic crowd reactions, not trading signals.",
    },
    {
      q: "Does anything touch the real chain?",
      a: "Only hashes. The crowd trades on a private fork that nobody else can reach. When the run is done, its hash and its scenario's hash are committed to the HyvoOracle contract on Robinhood Chain. A run with a question gets the hash of its outcome there too, after the date.",
    },
    {
      q: "Who are the agents?",
      a: "Archetypes such as a sniper, a holder or a skeptic, ten kinds in all, each under a generated handle. None of them is, or speaks for, a real person.",
    },
    {
      q: "Which models play them?",
      a: run ? (
        <>
          Every run lists its models under “How this run was made”, on its page. The run above used{" "}
          <span className="mono">{modelLabel(run.crowd.model.agents)}</span> for the agents and{" "}
          <span className="mono">{modelLabel(run.crowd.model.report)}</span> for the report.
        </>
      ) : (
        "Every run lists its models under “How this run was made”, on its page."
      ),
    },
    {
      q: "How can I tell a run was not changed?",
      a: (
        <>
          Each run page recomputes the hash from the file, in your browser. The <Link to="/oracle">oracle page</Link> then reads the commit from
          Robinhood Chain itself and compares the two. The <Link to="/docs#verify">docs</Link> show how to do the same with your own tools.
        </>
      ),
    },
    {
      q: "What does a run cost?",
      a:
        features && !features.payments
          ? "Paid runs are not open yet. When they open, a run is priced in dollars and paid in USDG, and you see the price before you pay."
          : "A run is priced in dollars and paid in USDG, and you see the price before you pay.",
    },
    {
      q: "Do I need a wallet?",
      a: "Not to watch runs, check hashes or use the free tools. A wallet signs you in with a signature, never a transaction. Paying for a run is a separate transaction you send yourself, for the exact amount shown.",
    },
    {
      q: "Is there a token?",
      a: HYVO_TOKEN ? (
        <>
          Yes: HYVO, at{" "}
          <span className="mono" style={{ overflowWrap: "anywhere" }}>
            {HYVO_TOKEN.address}
          </span>{" "}
          on Robinhood Chain. {ONLY_TOKEN} Holding it brings free runs, a discount and a place ahead in the queue. More on the{" "}
          <Link to="/token">token page</Link>.
        </>
      ) : (
        <>
          One is coming: HYVO. Holding it will bring free runs, a discount and a place ahead in the queue. More on the <Link to="/token">token page</Link>.
        </>
      ),
    },
    ...(SOURCE_URL
      ? [
          {
            q: "Is the code open?",
            a: (
              <>
                Yes, under the AGPL-3.0, and the engine builds on MiroFish.{" "}
                <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                  Read the source
                </a>
                .
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <section className={`${shared.section} ${styles.questions}`} aria-labelledby="questions-title">
      <Reveal className={styles.questionsHead}>
        <h2 id="questions-title">Questions</h2>
        <p>
          More in the <Link to="/docs">docs</Link> and on the <Link to="/trust">trust page</Link>.
        </p>
      </Reveal>
      <Reveal className={`${styles.answers} stagger`}>
        {items.map((item) => (
          <div key={item.q}>
            <details className={styles.question}>
              <summary>
                <span>{item.q}</span>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M8 3v10" pathLength={1} />
                  <path d="M3 8h10" pathLength={1} />
                </svg>
              </summary>
              <div className={styles.answer}>{item.a}</div>
            </details>
          </div>
        ))}
      </Reveal>
    </section>
  );
}
