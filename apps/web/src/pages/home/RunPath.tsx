import type { RunV1 } from "@hyvo/schema";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { Disclaimer } from "../../components/Disclaimer";
import { Arrow } from "../../components/Icons";
import { Reveal, useInView } from "../../components/Reveal";
import { fetchRunStatus } from "../../lib/api";
import { blockUrl, txUrl } from "../../lib/explorer";
import { modelLabel, shortHash } from "../../lib/format";
import { blocksBetween, crowdMix, runFacts, withoutCitations } from "../../lib/run-facts";
import { useAsync } from "../../lib/use-async";
import styles from "./RunPath.module.css";
import shared from "./Section.module.css";

/** "chain": on Robinhood Chain itself. "world": on the run's private chain. */
type Track = "chain" | "world";

interface Step {
  id: string;
  track: Track;
  title: string;
  body: string;
  /** The block on the real chain, for the two steps that happen there. */
  block?: ReactNode;
  /** What this step was in the featured run. */
  here?: ReactNode;
}

/** Where a run plays: a fork of Robinhood Chain, or a plain local test chain for a run that did not fork. */
type Place = "fork" | "local";

/** What every run goes through, in order. The featured run adds its own numbers beside each step. */
function steps(place: Place): Step[] {
  const where = place === "fork" ? "the fork" : "the test chain";
  return [
    place === "fork"
      ? {
          id: "fork",
          track: "chain",
          title: "Fork the chain at one block",
          body: "Hyvo copies Robinhood Chain at a single block into a private sandbox: the same contracts and balances, on a chain only this run can reach. Nothing that happens there touches the real one.",
        }
      : {
          id: "fork",
          track: "chain",
          title: "Start a private chain",
          body: "Most runs copy Robinhood Chain at a single block. This one played on a plain local test chain instead. Either way, nothing that happens there touches the real chain.",
        },
    {
      id: "crowd",
      track: "world",
      title: "Seat a crowd of archetypes",
      body: `Every agent plays one kind of trader under a generated handle, with its own wallet on ${where}. None of them is, or speaks for, a real person.`,
    },
    {
      id: "scenario",
      track: "world",
      title: "Hand it the scenario",
      body: "The scenario is written in plain words: a launch, a rumor, a listing. The crowd reads it before round 1 and again every round, and events can land in the rounds you choose.",
    },
    {
      id: "rounds",
      track: "world",
      title: "Let it play, round by round",
      body: `Each round, every agent reads the feed and the pool, then posts, replies, holds or trades. A trade is a real swap on ${where}, so the price is whatever the swaps make it.`,
    },
    {
      id: "report",
      track: "world",
      title: "Read it back, and check every line",
      body: "A larger model writes the report over numbers taken from the run: it picks the turning point and names the objections the crowd raised, while the mood round by round comes from the agents' own scores. A copy guard then takes out anything that reads as advice or a price prediction, and the run records what it took out.",
    },
    {
      id: "hash",
      track: "world",
      title: "Seal it in one hash",
      body: "The whole run is one file. Hyvo puts it in a canonical form and hashes it with keccak256, so anyone can recompute the hash from the file. Change one value in it and the hash no longer matches.",
    },
    {
      id: "commit",
      track: "chain",
      title: "Commit the hash to the real chain",
      body: "The run's hash, with its scenario's hash, goes to the HyvoOracle contract on Robinhood Chain. A run can be committed once, and a commit cannot be replaced. The trades stay where they were played; only hashes cross over.",
    },
  ];
}

const whole = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${whole(n)} ${n === 1 ? one : many}`;
const SHOWN_EVENTS = 3;

/**
 * The path every run takes, drawn like a branch off the chain: it leaves Robinhood Chain at the
 * fork block, plays on its own track, and comes back as hashes at the commit block. With a featured
 * run, each step shows what that run did there.
 */
export function RunPath({ run }: { run: RunV1 | null }) {
  const status = useAsync(async () => (run ? fetchRunStatus(run.runId) : null), run?.runId ?? "none");
  const place: Place = run && run.world.forkBlock === null ? "local" : "fork";
  const list = run ? stepsFor(run, status) : steps("fork");

  return (
    <section className={`${shared.section} ${styles.section}`} aria-labelledby="path-title">
      <Reveal className={shared.head}>
        <h2 id="path-title">{run ? "Every number above comes from one run you can check." : "How a run works"}</h2>
        <p>
          {!run
            ? "Every run takes the same path: off the real chain at one block, through a private world, and back as hashes."
            : place === "fork"
              ? "Here is that run, step by step: from the block where it left Robinhood Chain to the block that holds its hash."
              : "Here is that run, step by step: from the test chain it played on to the block that holds its hash."}
        </p>
      </Reveal>

      <ol className={styles.path} data-run={run ? "true" : "false"}>
        <li className={styles.origin} aria-hidden="true">
          <span className={styles.originLabel}>Robinhood Chain</span>
          <span className={styles.rail}>
            <span className={styles.main} />
          </span>
          {run && <span className={styles.hereHead}>In the run above</span>}
        </li>
        {list.map((step, index) => (
          <PathStep key={step.id} step={step} index={index} beforeCommit={list[index + 1]?.id === "commit"} />
        ))}
      </ol>

      {run && (
        <Reveal className={styles.after}>
          <Disclaimer />
          <div className={shared.links}>
            <Link to={`/run/${run.runId}`} className="arrow-link" viewTransition>
              Open the full run <Arrow />
            </Link>
            <Link to="/docs#verify" className="arrow-link" viewTransition>
              Check a hash yourself <Arrow />
            </Link>
          </div>
        </Reveal>
      )}
    </section>
  );
}

function PathStep({ step, index, beforeCommit }: { step: Step; index: number; beforeCommit: boolean }) {
  const [ref, seen] = useInView<HTMLLIElement>(0.2);
  const kind = step.id === "fork" ? "fork" : step.id === "commit" ? "commit" : step.track;
  return (
    <li
      ref={ref}
      className={styles.step}
      data-step={step.id}
      data-kind={kind}
      data-in={seen}
      data-before-commit={beforeCommit}
      data-here={step.here ? "true" : "false"}
      style={{ "--i": index } as CSSProperties}
    >
      <div className={styles.block}>{step.block}</div>
      <div className={styles.rail} aria-hidden="true">
        <span className={styles.main} />
        <span className={styles.branch} />
        {kind === "fork" && (
          <svg className={styles.curve} viewBox="0 0 44 30" data-dir="out">
            <path d="M11 0 C11 17 33 13 33 30" pathLength={1} />
          </svg>
        )}
        {kind === "commit" && (
          <svg className={styles.curve} viewBox="0 0 44 30" data-dir="in">
            <path d="M33 0 C33 17 11 13 11 30" />
          </svg>
        )}
        <span className={styles.node} />
      </div>
      <div className={styles.what}>
        <h3>
          <span className={`${styles.number} num`}>{index + 1}</span>
          {step.title}
        </h3>
        {step.block && <div className={styles.blockInline}>{step.block}</div>}
        <p>{step.body}</p>
      </div>
      {step.here && (
        <div className={styles.here}>
          <span className={styles.hereLabel}>In the run above</span>
          {step.here}
        </div>
      )}
    </li>
  );
}

type RunStatus = Awaited<ReturnType<typeof fetchRunStatus>>;
type StatusState = ReturnType<typeof useAsync<RunStatus | null>>;

/** A model id kept on one line where it fits, so it is not read as two names. */
function Model({ id }: { id: string }) {
  return <span className={`${styles.model} mono`}>{modelLabel(id)}</span>;
}

/** Each step with what the featured run did there, read from its file and its commit. */
function stepsFor(run: RunV1, status: StatusState): Step[] {
  const facts = runFacts(run);
  const { world, crowd, report, scenario } = run;
  const symbol = world.token.symbol;
  const pool = world.pools[0];
  const oracle = status.status === "ready" ? (status.data?.oracle ?? null) : null;
  const committed = oracle?.status === "confirmed" && oracle.txHash !== null ? { ...oracle, txHash: oracle.txHash } : null;
  const commitBlock = committed?.blockNumber ?? null;
  const gap = blocksBetween(world.forkBlock, commitBlock);
  const prices = [world.initialMarket.price, ...run.rounds.map((round) => round.market.price)].map(Number);
  const objections = report.objections.map(withoutCitations).filter((text) => text.length > 0);
  const events = scenario.injectedEvents;
  const where = world.forkBlock === null ? "the test chain" : "the fork";

  const commitHere = (): ReactNode => {
    if (status.status === "loading") return <span className={`${styles.wait} skeleton`} role="status" aria-label="Reading the commit…" />;
    if (status.status === "error") {
      return (
        <>
          <p>The commit could not be read just now.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={status.reload}>
            Try again
          </button>
        </>
      );
    }
    return (
      <>
        <p>
          {committed ? (
            <>
              Transaction{" "}
              <a className="mono" href={txUrl(committed.txHash)} target="_blank" rel="noreferrer" title={committed.txHash}>
                {shortHash(committed.txHash, 8, 6)}
              </a>
              {gap !== null && <>, {plural(gap, "block", "blocks")} after the fork, while the real chain kept going</>}.
            </>
          ) : oracle?.status === "failed" ? (
            "Its commit to Robinhood Chain is being retried."
          ) : oracle ? (
            "Its commit to Robinhood Chain is on its way."
          ) : (
            "This run is not committed on Robinhood Chain. Its hash can still be recomputed from the file and compared."
          )}
        </p>
        <Link to={`/oracle?run=${run.runId}`} className="arrow-link" viewTransition>
          Verify this run <Arrow />
        </Link>
      </>
    );
  };

  const here: Record<string, Pick<Step, "block" | "here">> = {
    fork: {
      ...(world.forkBlock !== null && {
        block: (
          <a href={blockUrl(world.forkBlock)} target="_blank" rel="noreferrer">
            Block <span className="num">{whole(world.forkBlock)}</span>
          </a>
        ),
      }),
      here: (
        <p>
          {world.forkBlock === null ? (
            "A plain local test chain, not a fork of Robinhood Chain. "
          ) : (
            <>
              Chain <span className="num">{world.chainId}</span> at block <span className="num">{whole(world.forkBlock)}</span>.{" "}
            </>
          )}
          {pool?.kind === "real"
            ? `The ${symbol}/${world.quote.symbol} pool, as it stood at that block. `
            : `A ${symbol}/${world.quote.symbol} test pool with a ${(pool?.feeBps ?? 0) / 100}% fee, set up on ${where}. `}
          {plural(world.initialMarket.holders, "wallet", "wallets")} held {symbol} before round 1.
        </p>
      ),
    },
    crowd: {
      here: (
        <p>
          {plural(crowd.size, "agent", "agents")}: {crowdMix(run)}. Played by <Model id={crowd.model.agents} />.
        </p>
      ),
    },
    scenario: {
      here: (
        <>
          <p className={styles.quote}>{scenario.title}</p>
          {events.length > 0 && (
            <ul className={styles.events}>
              {events.slice(0, SHOWN_EVENTS).map((event, index) => (
                <li key={index}>
                  <span className={`${styles.round} num`}>R{event.round}</span>
                  <span>{event.text}</span>
                </li>
              ))}
            </ul>
          )}
          {events.length > SHOWN_EVENTS && (
            <Link to={`/run/${run.runId}`} className={styles.small} viewTransition>
              and {plural(events.length - SHOWN_EVENTS, "more event", "more events")}, on the run&apos;s page
            </Link>
          )}
        </>
      ),
    },
    rounds: {
      here: (
        <>
          <p className={styles.counts}>
            <span>
              <b className="num">{whole(run.rounds.length)}</b> {run.rounds.length === 1 ? "round" : "rounds"}
            </span>
            <span>
              <b className="num">{whole(facts.decisions)}</b> decisions
            </span>
            <span data-tone="post">
              <b className="num">{whole(facts.posts)}</b> posts
            </span>
            <span data-tone="buy">
              <b className="num">{whole(facts.buys)}</b> buys
            </span>
            <span data-tone="sell">
              <b className="num">{whole(facts.sells)}</b> sells
            </span>
          </p>
          <PriceLine prices={prices} turningRound={report.turningPoint?.round ?? null} symbol={symbol} />
          {facts.reverted > 0 && <p className={styles.small}>{plural(facts.reverted, "swap", "swaps")} reverted on {where} and changed nothing.</p>}
        </>
      ),
    },
    report: {
      here: (
        <dl className={styles.facts}>
          {report.turningPoint && (
            <div>
              <dt>Turning point</dt>
              <dd>Round {report.turningPoint.round}</dd>
            </div>
          )}
          {objections.length > 0 && (
            <div>
              <dt>Objections</dt>
              <dd>{objections.map((text, i) => (i === 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text)).join("; ")}</dd>
            </div>
          )}
          {(facts.removedPosts > 0 || report.flags.length === 0) && (
            <div>
              <dt>Copy guard</dt>
              <dd>{facts.removedPosts > 0 ? `${plural(facts.removedPosts, "post", "posts")} taken out` : "Nothing taken out"}</dd>
            </div>
          )}
          <div>
            <dt>Written by</dt>
            <dd>
              <Model id={crowd.model.report} />
            </dd>
          </div>
        </dl>
      ),
    },
    hash: {
      here: (
        <>
          <p className={`${styles.hash} mono`} title={run.hash}>
            {shortHash(run.hash, 10, 8)}
          </p>
          <p className={styles.small}>Its page recomputes this from the file, in your browser.</p>
        </>
      ),
    },
    commit: {
      ...(commitBlock !== null && {
        block: (
          <a href={blockUrl(commitBlock)} target="_blank" rel="noreferrer">
            Block <span className="num">{whole(commitBlock)}</span>
          </a>
        ),
      }),
      here: commitHere(),
    },
  };

  return steps(world.forkBlock === null ? "local" : "fork").map((step) => ({ ...step, ...here[step.id] }));
}

/** The pool's price after each round, with the turning point shaded. Drawn from the run file. */
function PriceLine({ prices, turningRound, symbol }: { prices: number[]; turningRound: number | null; symbol: string }) {
  const width = 320;
  const height = 64;
  const pad = 4;
  if (prices.length < 2 || !prices.every(Number.isFinite)) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (prices.length - 1)) * (width - 2 * pad);
  // A flat price sits in the middle rather than on the floor.
  const y = (price: number) => (max === min ? height / 2 : pad + (1 - (price - min) / span) * (height - 2 * pad));
  const line = prices.map((price, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(price).toFixed(1)}`).join(" ");
  const rounds = prices.length - 1;
  const band = turningRound !== null && turningRound >= 1 && turningRound <= rounds ? { from: x(turningRound - 1), to: x(turningRound) } : null;
  const change = prices[0]! > 0 ? Math.round(((prices.at(-1)! - prices[0]!) / prices[0]!) * 1000) / 10 : null;
  const moved = change === null ? "" : change === 0 ? ", unchanged from the start" : `, ${change > 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)}% from the start`;
  return (
    <figure className={styles.price}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`The ${symbol} pool's price after ${rounds === 1 ? "its one round" : `each of ${rounds} rounds`}${moved}${band ? `; the turning point was round ${turningRound}` : ""}.`}
      >
        {band && <rect className={styles.band} x={band.from} y={0} width={band.to - band.from} height={height} />}
        <path className={styles.priceLine} d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption>Pool price after each round{band ? `. Shaded: the turning point, round ${turningRound}.` : "."}</figcaption>
    </figure>
  );
}
