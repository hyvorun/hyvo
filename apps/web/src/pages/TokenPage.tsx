import { ADDRESSES } from "../lib/addresses";
import { addressUrl } from "../lib/explorer";
import { HOLDER_DRAFT as DRAFT } from "../lib/holder";
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

/** The HYVO token: that it is coming, and what holding it is for. */
export function TokenPage() {
  useTitle("The HYVO token");
  useDescription("A HYVO token is coming. Holding it will bring free runs, a discount and a place ahead in the queue.");
  const address = ADDRESSES.hyvoToken;
  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>The HYVO token</h1>
        <p>A HYVO token is coming. Holding it will bring free runs, a discount and a place ahead in the queue.</p>
      </header>

      <section className={styles.status} aria-labelledby="token-status">
        <h2 id="token-status">{address ? "The official address" : "Coming soon"}</h2>
        {address ? (
          <a className={`mono ${styles.bigAddress}`} href={addressUrl(address)} target="_blank" rel="noreferrer">
            {address}
          </a>
        ) : (
          <p>Its address will appear here on the day it launches.</p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="token-holding">
        <h2 id="token-holding">What holding it does</h2>
        <ul className={styles.benefits}>
          <li>
            <b className="num">{DRAFT.freeRuns} free runs</b>
            <span>
              each month, of up to {DRAFT.freeAgents} agents and {DRAFT.freeRounds} rounds.
            </span>
          </li>
          <li>
            <b className="num">{DRAFT.discountPct}% off</b>
            <span>every paid run, Dry Run and Rewind.</span>
          </li>
          <li>
            <b>Ahead in the queue</b>
            <span>Your runs start before runs that are waiting without it.</span>
          </li>
        </ul>
        <p className={styles.muted}>Draft numbers, set at the launch.</p>
      </section>

      <section className={styles.section} aria-labelledby="token-planned">
        <h2 id="token-planned">Planned for holders</h2>
        <ul className={styles.planned}>
          {PLANNED.map((item) => (
            <li key={item.name}>
              <span className={styles.tag}>Planned</span>
              <b>{item.name}</b>
              <span>{item.line}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className={styles.fine}>Nothing on this page is financial advice, or an offer of anything.</p>
    </article>
  );
}
