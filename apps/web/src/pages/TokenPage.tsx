import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Arrow } from "../components/Icons";
import { CountUp } from "../components/motion-data/CountUp";
import { Copied } from "../components/motion-data/Copied";
import { Decode } from "../components/motion-data/Decode";
import { Reveal } from "../components/Reveal";
import { HOLDER_BENEFITS as BENEFITS, HOLDER_RULE_UNSET, fetchHolderTerms, holderRule } from "../lib/holder";
import { HYVO_TOKEN, ONLY_TOKEN, type OfficialToken } from "../lib/official";
import { useAsync } from "../lib/use-async";
import { useDescription, useTitle } from "../lib/use-title";
import styles from "./Info.module.css";

const PLANNED: { name: string; line: string }[] = [
  { name: "Holder tiers", line: "More free runs for larger holdings, held longer." },
  { name: "Private runs", line: "Runs that stay out of the gallery and can only be opened by your wallet." },
  { name: "Questions included", line: "A monthly allowance of questions to a run's agents." },
  { name: "A vote on the weekly scenario", line: "Holders pick the scenario the community run plays each week." },
  { name: "Your own archetypes", line: "Describe a kind of trader and add it to your crowd." },
  { name: "A larger API allowance", line: "More requests for programs and AI agents that use Hyvo." },
];

const COMING = "A HYVO token is coming. Holding it will bring free runs, a discount and a place ahead in the queue.";
const LIVE = "HYVO is live on Robinhood Chain. Holding it brings free runs, a discount and a place ahead in the queue.";

/**
 * The HYVO token. Before the launch: that it is coming, and that no token is Hyvo's yet. After it:
 * its one address. Both say what holding it does, and nothing else about it.
 */
export function TokenPage() {
  const token = HYVO_TOKEN;
  useTitle("The HYVO token");
  useDescription(token ? `${LIVE} Its only address is ${token.address}.` : COMING);
  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>The HYVO token</h1>
        <p>{token ? LIVE : COMING}</p>
      </header>

      {token ? (
        <OfficialAddress token={token} />
      ) : (
        <section className={styles.status} aria-labelledby="token-status">
          <h2 id="token-status">Coming soon</h2>
          <p>
            Hyvo has not launched a token yet, so no token named HYVO is Hyvo&apos;s today. Its address will appear here on the day it
            launches.
          </p>
        </section>
      )}

      <section className={styles.section} aria-labelledby="token-holding">
        <h2 id="token-holding">What holding it does</h2>
        <Reveal as="ul" className={`${styles.benefits} stagger`}>
          <li>
            <b className="num">
              <CountUp value={BENEFITS.freeRuns} format={String} /> free runs
            </b>
            <span>
              each month, of up to {BENEFITS.freeAgents} agents and {BENEFITS.freeRounds} rounds.
            </span>
          </li>
          <li>
            <b className="num">
              <CountUp value={BENEFITS.discountPct} format={(n) => `${n}%`} /> off
            </b>
            <span>every paid run, Dry Run and Rewind.</span>
          </li>
          <li>
            <b>Ahead in the queue</b>
            <span>Your runs start before runs that are waiting without it.</span>
          </li>
        </Reveal>
        {token ? <HolderRule /> : <p className={styles.muted}>Draft numbers, set at the launch.</p>}
      </section>

      <section className={styles.section} aria-labelledby="token-planned">
        <h2 id="token-planned">Planned for holders</h2>
        <Reveal as="ul" className={`${styles.planned} stagger`}>
          {PLANNED.map((item) => (
            <li key={item.name}>
              <span className={styles.tag}>Planned</span>
              <b>{item.name}</b>
              <span>{item.line}</span>
            </li>
          ))}
        </Reveal>
      </section>

      <p className={styles.fine}>Nothing on this page is financial advice, or an offer of anything.</p>
    </article>
  );
}

/** The one address, large, with a copy button and the pages that read it: the explorer, Hyvo Check and Hyvo Launches. */
function OfficialAddress({ token }: { token: OfficialToken }) {
  const [copied, setCopied] = useState(false);
  const addressRef = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.address);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The clipboard can be refused: select the address instead, so it can be copied by hand.
      if (addressRef.current) window.getSelection()?.selectAllChildren(addressRef.current);
    }
  };

  return (
    <section className={`${styles.status} ${styles.official}`} aria-labelledby="token-status">
      <p className={styles.eyebrow}>
        <span className="live-dot" aria-hidden="true" /> Live on Robinhood Chain
      </p>
      <h2 id="token-status">The official address</h2>
      <div ref={addressRef} className={`mono ${styles.bigAddress}`}>
        <Decode text={token.address} duration={900} />
      </div>
      <div className={styles.addressActions}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
          {/* Both labels share one cell, so the button keeps its width when it says "Copied". */}
          <span className={styles.swap}>
            <span className={copied ? styles.away : undefined}>Copy the address</span>
            {copied && <Copied>Copied</Copied>}
          </span>
        </button>
        <a className="arrow-link" href={token.explorerUrl} target="_blank" rel="noreferrer">
          On {token.explorerName} <Arrow />
        </a>
        <Link className="arrow-link" to={token.checkPath} viewTransition>
          In Hyvo Check <Arrow />
        </Link>
        <Link className="arrow-link" to={token.launchPath} viewTransition>
          In Hyvo Launches <Arrow />
        </Link>
        <span role="status" className="visually-hidden">
          {copied ? "The address is copied." : ""}
        </span>
      </div>
      <p className={styles.only}>{ONLY_TOKEN}</p>
    </section>
  );
}

/** A sentence as long as the holder rule usually is, for the room it keeps while the API answers. */
const SAMPLE_RULE = holderRule({ min: "1000000", decimals: 18, heldForSeconds: 86_400 });

/** Who counts as a holder, as the API states it; until it does, that this is set at the launch. */
function HolderRule() {
  const terms = useAsync(fetchHolderTerms, "holder-terms");
  const rule = terms.status === "ready" ? holderRule(terms.data) : terms.status === "error" ? HOLDER_RULE_UNSET : null;
  return (
    <div className={styles.holder}>
      <h3>Who counts as a holder</h3>
      {/* Both possible sentences hold their room, hidden, from the start: nothing below moves when the answer comes. */}
      <p className={styles.rule} data-unset={HOLDER_RULE_UNSET} data-sample={SAMPLE_RULE} aria-busy={rule === null}>
        {rule !== null && <span className="enter">{rule}</span>}
      </p>
      <p className={styles.muted}>
        Sign in with the wallet that holds it when you start a run: the checkout offers its free runs and applies the discount. Hyvo
        only reads the balance; nothing is locked or moved.
      </p>
    </div>
  );
}
