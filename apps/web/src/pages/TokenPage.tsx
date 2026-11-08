import { Link } from "react-router";
import { Arrow } from "../components/Icons";
import { ADDRESSES } from "../lib/addresses";
import { addressUrl } from "../lib/explorer";
import { useDescription, useTitle } from "../lib/use-title";
import styles from "./Info.module.css";

/*
 * The holder settings below mirror apps/api/wrangler.jsonc (FREE_RUNS_PER_MONTH, FREE_RUN_MAX_AGENTS,
 * FREE_RUN_MAX_ROUNDS, HOLDER_DISCOUNT_BPS) and apps/api/src/lib/holder.ts. They are drafts until
 * the launch; change them together.
 */
const DRAFT = { freeRuns: 2, freeAgents: 50, freeRounds: 10, discountPct: 20 };

const PLANNED: { name: string; line: string }[] = [
  { name: "Holder tiers", line: "More free runs for larger holdings, held longer." },
  { name: "Private runs", line: "Runs that stay out of the gallery and can only be opened by your wallet." },
  { name: "Questions included", line: "A monthly allowance of questions to a run's agents." },
  { name: "A vote on the weekly scenario", line: "Holders pick the scenario the community run plays each week." },
  { name: "Your own archetypes", line: "Describe a kind of trader and add it to your crowd." },
  { name: "A larger API allowance", line: "More requests for programs and AI agents that use Hyvo." },
];

/** What the HYVO token is, what holding it does, and what it never does. */
export function TokenPage() {
  useTitle("The HYVO token");
  useDescription("The HYVO token: not launched yet. What holding it will do (free runs, a discount, queue priority), what it never does, and how to tell the official token.");
  const address = ADDRESSES.hyvoToken;
  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>The HYVO token</h1>
        <p>
          Holding HYVO will bring free runs, a discount and a place ahead in the queue. It will never pay anything out. Paying for runs does not need it: they are
          priced in dollars and paid in USDG.
        </p>
      </header>

      <section className={styles.status} aria-labelledby="token-status">
        <h2 id="token-status">{address ? "The official address" : "Not launched yet"}</h2>
        {address ? (
          <>
            <a className={`mono ${styles.bigAddress}`} href={addressUrl(address)} target="_blank" rel="noreferrer">
              {address}
            </a>
            <p>This is the only HYVO token. Compare every character before you trade anything called HYVO.</p>
          </>
        ) : (
          <p>
            There is no official HYVO token yet. Its address will appear here on the day it launches. Until then, any token called HYVO is not Hyvo&apos;s.
          </p>
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
        <p className={styles.muted}>
          Draft settings: the numbers and the minimum balance are set when the token launches, and shown here.
        </p>
        <div className={styles.prose}>
          <h3>How a holding is checked</h3>
          <p>
            You sign in with your wallet, which is a signature and not a transaction. Hyvo then reads your balance twice: now, and at the block of 24 hours ago. Both
            have to be at or above the minimum, so a token borrowed for a moment does not count. If the chain cannot be read, the benefits wait until it can.
          </p>
          <p>Nothing is staked, locked, approved or sent. The tokens never leave your wallet unless you move them, and the benefits simply follow the balance.</p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="token-not">
        <h2 id="token-not">What it is not</h2>
        <ul className={styles.nots}>
          <li>
            <b>Not a share of anything.</b> It pays no yield, no part of Hyvo&apos;s revenue and no profits.
          </li>
          <li>
            <b>Not a promise about its price.</b> Nothing on this site says what it is or will be worth.
          </li>
          <li>
            <b>Not needed to use Hyvo.</b> Everything can be paid for in USDG. Paying in HYVO needs a fair price source, which will be chosen after the launch.
          </li>
          <li>
            <b>Not a vote on the company.</b> Holders may get to choose scenarios. They do not own or control Hyvo.
          </li>
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="token-money">
        <h2 id="token-money">Where the money goes</h2>
        <div className={styles.prose}>
          <p>
            Runs are paid in USDG through the PaymentRouter contract, straight to the treasury in the same transaction. The <Link to="/trust">trust page</Link> reads
            both from the chain.
          </p>
          <p>
            HYVO is planned to launch on Pons, a launchpad on Robinhood Chain. Pons charges a fee on trades, and part of that fee goes to the token&apos;s creator,
            Hyvo&apos;s founder. That income pays for servers and AI models. Holders do not receive it, and nothing is promised to them.
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="token-planned">
        <h2 id="token-planned">Planned for holders</h2>
        <p className={styles.muted}>Not built yet, and plans can change. None of them is a promise about the token&apos;s value.</p>
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

      <section className={styles.safety} aria-labelledby="token-safe">
        <h2 id="token-safe">Staying safe</h2>
        <ul>
          <li>Hyvo never sends direct messages, and never asks for a seed phrase.</li>
          <li>No benefit ever needs you to approve HYVO to a contract, or to send it anywhere.</li>
          <li>Sign-in on this site asks for a signature. A sign-in that asks for a transaction is not Hyvo&apos;s.</li>
        </ul>
      </section>

      <div className={styles.links}>
        <Link to="/trust" className="arrow-link" viewTransition>
          What Hyvo never does <Arrow />
        </Link>
        <Link to="/tools/glossary#approval" className="arrow-link" viewTransition>
          What an approval is <Arrow />
        </Link>
      </div>
      <p className={styles.fine}>Nothing on this page is financial advice, or an offer of anything.</p>
    </article>
  );
}
