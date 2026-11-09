import { Link } from "react-router";
import { Arrow } from "../../components/Icons";
import { CountUp } from "../../components/motion-data/CountUp";
import { Decode } from "../../components/motion-data/Decode";
import { Reveal } from "../../components/Reveal";
import { HOLDER_BENEFITS, PLANNED_RULE } from "../../lib/holder";
import { HYVO_TOKEN, ONLY_TOKEN } from "../../lib/official";
import styles from "./Briefs.module.css";
import shared from "./Section.module.css";

/** The token in short: what holding it is for, and once it has launched, its one address. */
export function TokenBrief() {
  const token = HYVO_TOKEN;
  return (
    <section className={shared.section} aria-labelledby="token-title">
      <Reveal className={shared.head}>
        <h2 id="token-title">The HYVO token</h2>
        <p>
          {token
            ? "HYVO is live. Holding it brings free runs, a discount and a place ahead in the queue."
            : "A HYVO token is coming. Holding it will bring free runs, a discount and a place ahead in the queue."}
        </p>
      </Reveal>

      <Reveal as="ul" className={`${styles.benefits} stagger`} data-count="3">
        <li>
          <b className="num">
            <CountUp value={HOLDER_BENEFITS.freeRuns} format={String} /> free runs
          </b>
          <span>
            a month, of up to {HOLDER_BENEFITS.freeAgents} agents and {HOLDER_BENEFITS.freeRounds} rounds.
          </span>
        </li>
        <li>
          <b className="num">
            <CountUp value={HOLDER_BENEFITS.discountPct} format={(n) => `${n}%`} /> off
          </b>
          <span>every paid run, Dry Run and Rewind.</span>
        </li>
        <li>
          <b>Ahead in the queue</b>
          <span>Your runs start before runs that are waiting without it.</span>
        </li>
      </Reveal>

      {token && (
        <Reveal className={styles.contracts}>
          <Link to="/token" className={`${styles.contract} press`} viewTransition>
            <span className={styles.contractName}>The official address</span>
            {/* The address wraps on a phone rather than push the page sideways. */}
            <span className="mono" style={{ overflowWrap: "anywhere" }}>
              <Decode text={token.address} duration={900} />
            </span>
            <span className={styles.contractWhat}>{ONLY_TOKEN}</span>
          </Link>
        </Reveal>
      )}

      <div className={styles.tokenFoot}>
        <p className={styles.fine}>
          {token ? "Held in your own wallet: Hyvo only reads the balance." : PLANNED_RULE}
        </p>
        <Link to="/token" className="arrow-link" viewTransition>
          What the token is for <Arrow />
        </Link>
      </div>
    </section>
  );
}
