import { RUN_PERSONAS, type RunV1 } from "@hyvo/schema";
import { Link } from "react-router";
import { Console } from "../components/Console";
import { Arrow } from "../components/Icons";
import { Reveal } from "../components/Reveal";
import { Failure } from "../components/States";
import { fetchFeatured, fetchRunDocument, fetchRunStatus } from "../lib/api";
import { blockUrl, txUrl } from "../lib/explorer";
import { personaLabel, shortHash } from "../lib/format";
import { HOME_TOOLS } from "../lib/tools";
import { useAsync } from "../lib/use-async";
import styles from "./HomePage.module.css";

export function HomePage() {
  const featured = useAsync(async () => {
    const summary = await fetchFeatured();
    return summary ? { summary, run: await fetchRunDocument(summary.runId) } : null;
  }, "featured");
  const data = featured.status === "ready" ? featured.data : null;

  return (
    <>
      <section className={styles.hero}>
        <h1 className={styles.display}>Launch it in a parallel world first.</h1>
        <div className={styles.intro}>
          <p className={styles.lede}>
            Put a token launch, a rumor or a listing in front of a crowd of AI traders. They post, argue and swap against real
            AMM math on a private fork of Robinhood Chain. Every run is hashed, so anyone can check it.
          </p>
          <div className={styles.actions}>
            <Link to="/new" className="btn btn-primary" viewTransition>
              Run a simulation
            </Link>
            <Link to="/runs" className={styles.quiet} viewTransition>
              See all runs
            </Link>
          </div>
        </div>
      </section>

      <section className={styles.stage} aria-label="The featured run">
        {featured.status === "loading" && <div className={`${styles.placeholder} card skeleton`} role="status" aria-label="Loading the featured run…" />}
        {featured.status === "error" && <Failure message={featured.error.message} onRetry={featured.reload} />}
        {featured.status === "ready" && !data && (
          <p className={`${styles.none} card`}>No run is published yet. The first published run will play here.</p>
        )}
        {data && <Console run={data.run} />}
      </section>

      {data ? <Proof run={data.run} /> : featured.status !== "loading" && <HowItWorks />}

      <FreeTools />

      <Reveal as="section" className={styles.closing} aria-labelledby="closing-title">
        <h2 id="closing-title">Put your launch in front of the crowd first.</h2>
        <Link to="/new" className="btn btn-primary" viewTransition>
          Run a simulation
        </Link>
      </Reveal>
    </>
  );
}

/** A few of the free tools, for people who came to look rather than to run something. */
function FreeTools() {
  return (
    <section className={styles.tools} aria-labelledby="tools-title">
      <Reveal className={styles.toolsHead}>
        <h2 id="tools-title">Free tools, no wallet needed</h2>
        <Link to="/tools" className="arrow-link" viewTransition>
          All tools <Arrow />
        </Link>
      </Reveal>
      <ul className={styles.toolGrid}>
        {HOME_TOOLS.map((tool, index) => (
          <Reveal as="li" index={index} key={tool.to}>
            <Link to={tool.to} viewTransition>
              <b>{tool.name}</b>
              <span>{tool.line}</span>
            </Link>
          </Reveal>
        ))}
      </ul>
    </section>
  );
}

/** "10 snipers, 15 holders, 10 panic sellers and 15 skeptics", in the order the crowd lists them. */
function crowdMix(run: RunV1): string {
  const known = RUN_PERSONAS as readonly string[];
  const counts = new Map<string, number>();
  for (const agent of run.crowd.agents) counts.set(agent.persona, (counts.get(agent.persona) ?? 0) + 1);
  const rank = (persona: string) => (known.includes(persona) ? known.indexOf(persona) : known.length);
  const parts = [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([persona, count]) => {
      const label = personaLabel(persona, count);
      // "KOL followers" keeps its capitals; "Snipers" reads as "snipers" mid-sentence.
      const name = /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
      return `${count.toLocaleString("en-US")} ${name}`;
    });
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

/** Where every number in the console comes from: the fork, the crowd and the hash anyone can check. */
function Proof({ run }: { run: RunV1 }) {
  const status = useAsync(() => fetchRunStatus(run.runId), run.runId);
  const oracle = status.status === "ready" ? status.data.oracle : null;
  const committed = oracle?.status === "confirmed" && oracle.txHash !== null ? oracle.txHash : null;

  return (
    <section className={styles.proof} aria-labelledby="proof-title">
      <Reveal>
        <h2 id="proof-title">Every number above comes from one run you can check.</h2>
      </Reveal>
      <ul className={styles.facts}>
        <Reveal as="li" index={0} className={styles.fact}>
          <span className={styles.factLabel}>Fork</span>
          {run.world.forkBlock === null ? (
            <>
              <span className={styles.factValue}>A local test chain</span>
              <p>This run played on a plain local test chain, not on a fork of Robinhood Chain.</p>
            </>
          ) : (
            <>
              <a className={styles.factValue} href={blockUrl(run.world.forkBlock)} target="_blank" rel="noreferrer">
                Block <span className="num">{run.world.forkBlock.toLocaleString("en-US")}</span>
              </a>
              <p>A private copy of Robinhood Chain, chain ID {run.world.chainId}. The crowd's swaps never reach the real chain.</p>
            </>
          )}
        </Reveal>
        <Reveal as="li" index={1} className={styles.fact}>
          <span className={styles.factLabel}>Crowd</span>
          <span className={styles.factValue}>
            {run.crowd.size.toLocaleString("en-US")} agents, {run.rounds.length} rounds
          </span>
          <p>{crowdMix(run)}. Archetypes with generated handles, never real people.</p>
        </Reveal>
        <Reveal as="li" index={2} className={styles.fact}>
          <span className={styles.factLabel}>Hash</span>
          <span className={`${styles.factValue} mono`} title={run.hash}>
            {shortHash(run.hash, 8, 6)}
          </span>
          <p>
            {committed ? (
              <>
                Committed on Robinhood Chain in transaction{" "}
                <a className="mono" href={txUrl(committed)} target="_blank" rel="noreferrer" title={committed}>
                  {shortHash(committed, 8, 6)}
                </a>
                .{" "}
              </>
            ) : oracle ? (
              "Its commit to Robinhood Chain is on its way. "
            ) : (
              "Recompute it from the run file and compare. "
            )}
            <Link to={`/oracle?run=${run.runId}`} viewTransition>
              Verify this run
            </Link>
          </p>
        </Reveal>
      </ul>
    </section>
  );
}

/** With no run to point at, the same three parts in general terms. */
function HowItWorks() {
  return (
    <section className={styles.proof} aria-labelledby="how-title">
      <Reveal>
        <h2 id="how-title">How a run works</h2>
      </Reveal>
      <ul className={styles.facts}>
        <Reveal as="li" index={0} className={styles.fact}>
          <span className={styles.factLabel}>Fork</span>
          <span className={styles.factValue}>A private copy of the chain</span>
          <p>Each run forks Robinhood Chain at one block. The crowd's swaps stay on that fork and never reach the real chain.</p>
        </Reveal>
        <Reveal as="li" index={1} className={styles.fact}>
          <span className={styles.factLabel}>Crowd</span>
          <span className={styles.factValue}>A crowd of archetypes</span>
          <p>Agents with generated handles, never real people, read one feed, then post, argue and swap against real AMM math.</p>
        </Reveal>
        <Reveal as="li" index={2} className={styles.fact}>
          <span className={styles.factLabel}>Hash</span>
          <span className={styles.factValue}>One file, one hash</span>
          <p>The result is one file. Its hash is committed on Robinhood Chain, so anyone can recompute it and compare.</p>
        </Reveal>
      </ul>
    </section>
  );
}
