import { Fragment, useMemo, type CSSProperties } from "react";
import { Link } from "react-router";
import { Console } from "../components/Console";
import { Arrow } from "../components/Icons";
import { Reveal } from "../components/Reveal";
import { Failure } from "../components/States";
import { fetchFeatured, fetchHealth, fetchRunDocument } from "../lib/api";
import { personaCounts } from "../lib/run-facts";
import { HOME_TOOLS } from "../lib/tools";
import { useAsync } from "../lib/use-async";
import styles from "./HomePage.module.css";
import { Capabilities } from "./home/Capabilities";
import { CrowdGuide } from "./home/CrowdGuide";
import { Questions } from "./home/Questions";
import { RunPath } from "./home/RunPath";
import { TokenBrief } from "./home/TokenBrief";
import { TrustBrief } from "./home/TrustBrief";

const HEADLINE = "Launch it in a parallel world first.";

export function HomePage() {
  const featured = useAsync(async () => {
    const summary = await fetchFeatured();
    return summary ? { summary, run: await fetchRunDocument(summary.runId) } : null;
  }, "featured");
  const data = featured.status === "ready" ? featured.data : null;
  const health = useAsync(fetchHealth, "health");
  const features = health.status === "ready" ? health.data.features : null;
  const run = data?.run ?? null;
  const seated = useMemo(() => (run ? personaCounts(run) : null), [run]);

  return (
    <>
      <section className={styles.hero}>
        <h1 className={styles.display}>
          {HEADLINE.split(" ").map((word, index, words) => (
            <Fragment key={index}>
              <span className={styles.mask}>
                <span className={styles.word} style={{ "--w": index } as CSSProperties}>
                  {word}
                </span>
              </span>
              {index < words.length - 1 && " "}
            </Fragment>
          ))}
        </h1>
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

      <section className={styles.stage} aria-labelledby="featured-title">
        <h2 id="featured-title" className="visually-hidden">
          The featured run
        </h2>
        {featured.status === "loading" && <div className={`${styles.placeholder} card skeleton`} role="status" aria-label="Loading the featured run…" />}
        {featured.status === "error" && <Failure message={featured.error.message} onRetry={featured.reload} />}
        {featured.status === "ready" && !data && (
          <p className={`${styles.none} card`}>No run is published yet. The first published run will play here.</p>
        )}
        {data && <Console run={data.run} />}
      </section>

      {run ? <RunPath run={run} /> : featured.status !== "loading" && <RunPath run={null} />}

      <CrowdGuide seated={seated} />

      <Capabilities features={features} loading={health.status === "loading"} />

      <TrustBrief />

      <TokenBrief />

      <Questions run={run} features={features} />

      <FreeTools />

      <Reveal as="section" className={`${styles.closing} stagger`} aria-labelledby="closing-title">
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
      <Reveal as="ul" className={`${styles.toolGrid} stagger`}>
        {HOME_TOOLS.map((tool) => (
          <li key={tool.to}>
            <Link to={tool.to} className="press" viewTransition>
              <b>{tool.name}</b>
              <span>
                {tool.line} <Arrow />
              </span>
            </Link>
          </li>
        ))}
      </Reveal>
    </section>
  );
}
