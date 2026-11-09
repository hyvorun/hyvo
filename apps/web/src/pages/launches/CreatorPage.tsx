import { distinctName, formatBlock, formatBps, phaseLabel, shortAddress, type Launch, type Phase } from "@hyvo/launches";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Arrow } from "../../components/Icons";
import { CountUp } from "../../components/motion-data/CountUp";
import { Reveal } from "../../components/Reveal";
import { Failure } from "../../components/States";
import { addressUrl } from "../../lib/explorer";
import { tokenFromPath } from "../../lib/launches";
import { useDescription, useTitle } from "../../lib/use-title";
import { Age, Amount, pairLabel, Provenance, Towards } from "./parts";
import { CREATOR_STATES_READ, graduatedCount, useCreator } from "./use-creator";
import styles from "./Launches.module.css";

/** One wallet's Pons V2 launches: the list from the factory's logs, and each launch's state now from the chain. */
export function CreatorPage() {
  const params = useParams();
  const address = tokenFromPath(params.address);
  const [attempt, setAttempt] = useState(0);
  const state = useCreator(address, attempt, "full");
  useTitle(address ? `Creator ${shortAddress(address, 6, 4)} · Launches` : "Creator");
  useDescription("Every Pons V2 launch by one wallet on Robinhood Chain, with each one's state read from the chain. Not a trading signal.");
  const launches = state.answer?.launches ?? [];
  const graduated = graduatedCount(state.phases);
  const now = state.reads[0]?.timestamp ?? Math.floor(Date.now() / 1000);

  return (
    <article className={styles.page}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/launches" viewTransition>
          Launches
        </Link>
        <span aria-hidden="true">/</span>
        <span>Creator</span>
      </nav>
      <header className={styles.head}>
        <p className={styles.eyebrow}>Creator</p>
        <h1 className="mono">{address ? shortAddress(address, 6, 4) : "Not an address"}</h1>
        {address && (
          <p className={styles.lead}>
            Every Pons V2 launch whose launch event names <span className="mono">{address}</span> as its deployer, and where each one stands now.{" "}
            <a className="arrow-link" href={addressUrl(address)} target="_blank" rel="noreferrer">
              Open the wallet on the block explorer <Arrow />
            </a>
          </p>
        )}
      </header>

      {!address && (
        <p className={styles.lead}>
          A wallet address is 0x followed by 40 hexadecimal characters. <span className="mono">{(params.address ?? "").slice(0, 48)}</span> is not one.{" "}
          <Link to="/launches" className="arrow-link" viewTransition>
            See the newest launches <Arrow />
          </Link>
        </p>
      )}
      {address && state.status === "loading" && (
        <p className={styles.provenance} role="status">
          Asking for this wallet&apos;s launches…
        </p>
      )}
      {address && state.status === "error" && <Failure message={state.error ?? "This wallet's launches could not be read just now."} onRetry={() => setAttempt((n) => n + 1)} />}
      {address && state.status === "ready" && state.answer && (
        <>
          <ul className={styles.stats} aria-label="This wallet on Pons">
            <li>
              <b className="num">
                <CountUp value={launches.length} format={String} />
              </b>
              <span>{launches.length === 1 ? "Launch" : "Launches"} on Pons V2{state.answer.data.complete ? "" : " (the list may be incomplete)"}</span>
            </li>
            <li>
              <b className="num">{state.chain === "ready" ? <CountUp value={graduated} format={String} /> : "…"}</b>
              <span>Graduated to a Uniswap V4 pool{launches.length > CREATOR_STATES_READ ? ` (of the newest ${CREATOR_STATES_READ})` : ""}</span>
            </li>
          </ul>
          <p className={styles.fine}>
            The list: {state.answer.data.source}.{" "}
            {state.chain === "ready" && state.reads.length > 0 ? null : state.chain === "error" ? state.chainError : "Reading each launch from the chain…"}
          </p>
          {launches.length === 0 ? (
            <p className={styles.note}>This wallet has not launched a token through the Pons V2 factory.</p>
          ) : (
            <section className={styles.section} aria-labelledby="creator-launches-title">
              <div className={styles.sectionHead}>
                <h2 id="creator-launches-title">Its launches, newest first</h2>
              </div>
              {state.chain === "ready" && state.launches.length > 0 ? (
                <Reveal as="ol" className={`${styles.rows} stagger`}>
                  {state.launches.map((launch) => (
                    <CreatorRow key={launch.token} launch={launch} phase={state.phases.get(launch.token.toLowerCase()) ?? null} now={now} />
                  ))}
                </Reveal>
              ) : (
                <ol className={styles.rows}>
                  {launches.slice(0, 50).map((launch) => (
                    <li key={launch.token}>
                      <Link to={`/launches/${launch.token}`} className={styles.rowLink} viewTransition>
                        <span className={styles.token}>
                          <b className="mono">{shortAddress(launch.token, 6, 4)}</b>
                        </span>
                        <span className={styles.age}>
                          block <span className="num">{formatBlock(launch.block)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          <Provenance reads={state.reads} served={state.served} />
          <p className={styles.fine}>
            Hyvo Launches is not affiliated with this wallet, its tokens or Pons. These are facts from the factory&apos;s events and the chain&apos;s contracts; they say
            nothing about where any price goes.
          </p>
        </>
      )}
    </article>
  );
}

function CreatorRow({ launch, phase, now }: { launch: Launch; phase: Phase | null; now: number }) {
  return (
    <li>
      <Link to={`/launches/${launch.token}`} className={styles.rowLink} viewTransition>
        <span className={styles.age}>
          <span className="visually-hidden">Launched </span>
          <Age at={launch.launchedAt} now={now} />
          <span className="visually-hidden"> ago</span>
        </span>
        <span className={styles.token}>
          <b>{launch.symbol ?? shortAddress(launch.token)}</b>
          <span>{distinctName(launch.name, launch.symbol) ?? phaseLabel(phase, launch.graduated)}</span>
        </span>
        <span className={styles.pair}>
          <span className="visually-hidden">Pair asset: </span>
          {pairLabel(launch.pair)}
        </span>
        <span className={styles.progressCell}>
          <span className="visually-hidden">Towards graduation: </span>
          <Towards liquidity={launch.liquidity} threshold={launch.graduationThreshold} graduated={phase === "graduated" || launch.graduated} />
        </span>
        <span className={styles.liquidity}>
          <span className="visually-hidden">On its curve: </span>
          {launch.graduated ? <span className={styles.unknown}>Moved to its pool</span> : <Amount value={launch.liquidity} asset={launch.pair} />}
        </span>
        <span className={styles.tax}>
          <span className={styles.taxLabel}>Creator tax </span>
          {launch.creatorTaxBps === null ? <span className={styles.unknown}>Not read</span> : <span className="num">{formatBps(launch.creatorTaxBps)}</span>}
        </span>
      </Link>
    </li>
  );
}
