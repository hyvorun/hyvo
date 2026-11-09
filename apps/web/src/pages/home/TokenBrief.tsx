import { Link } from "react-router";
import { Arrow } from "../../components/Icons";
import { Reveal } from "../../components/Reveal";
import { ADDRESSES } from "../../lib/addresses";
import { HOLDER_DRAFT } from "../../lib/holder";
import styles from "./Briefs.module.css";
import shared from "./Section.module.css";

/** The token in short: that it is coming, and what holding it is for. */
export function TokenBrief() {
  const launched = Boolean(ADDRESSES.hyvoToken);
  return (
    <section className={shared.section} aria-labelledby="token-title">
      <Reveal className={shared.head}>
        <h2 id="token-title">The HYVO token</h2>
        <p>
          {launched
            ? "Holding HYVO brings free runs, a discount and a place ahead in the queue."
            : "A HYVO token is coming. Holding it will bring free runs, a discount and a place ahead in the queue."}
        </p>
      </Reveal>

      <ul className={styles.benefits} data-count="3">
        <Reveal as="li" index={0}>
          <b className="num">{HOLDER_DRAFT.freeRuns} free runs</b>
          <span>
            a month, of up to {HOLDER_DRAFT.freeAgents} agents and {HOLDER_DRAFT.freeRounds} rounds.
          </span>
        </Reveal>
        <Reveal as="li" index={1}>
          <b className="num">{HOLDER_DRAFT.discountPct}% off</b>
          <span>every paid run, Dry Run and Rewind.</span>
        </Reveal>
        <Reveal as="li" index={2}>
          <b>Ahead in the queue</b>
          <span>Your runs start before runs that are waiting without it.</span>
        </Reveal>
      </ul>

      <div className={styles.tokenFoot}>
        <p className={styles.fine}>Draft numbers, set at the launch.</p>
        <Link to="/token" className="arrow-link" viewTransition>
          What the token is for <Arrow />
        </Link>
      </div>
    </section>
  );
}
