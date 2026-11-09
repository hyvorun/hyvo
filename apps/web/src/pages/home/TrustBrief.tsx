import { Link } from "react-router";
import { Arrow } from "../../components/Icons";
import { Reveal } from "../../components/Reveal";
import { ADDRESSES } from "../../lib/addresses";
import { addressUrl } from "../../lib/explorer";
import { shortHash } from "../../lib/format";
import styles from "./Briefs.module.css";
import shared from "./Section.module.css";

const SOURCE_URL = ((import.meta.env.VITE_SOURCE_URL as string | undefined) ?? "").trim();

/** The trust page's promises, one line each. The page itself has how to check every one. */
const PROMISES: { never: string; how: string }[] = [
  {
    never: "Keeps your money in a contract",
    how: "A payment goes through the PaymentRouter contract to the treasury in the same transaction; the contract has no function that keeps one. A prepaid balance is credit for runs, not a deposit, and earns nothing.",
  },
  {
    never: "Moves or approves your tokens",
    how: "Signing in is a signature on a message, never a transaction. A payment is a transaction you send yourself, for the exact amount shown. Holder benefits only read a balance.",
  },
  {
    never: "Changes a published run",
    how: "Its hash is committed on Robinhood Chain once, and a commit cannot be replaced.",
  },
  {
    never: "Gives trading advice",
    how: "A copy guard takes out posts and report lines that read as advice or as a price prediction, and each run lists what it took out.",
  },
  {
    never: "Imitates real people",
    how: "Agents play archetypes under generated handles. None of them is, or speaks for, a real person.",
  },
  {
    never: "Upgrades its contracts",
    how: "No proxy, no self-destruct, no delegate calls: the code on the chain is the code that runs.",
  },
];

/** What Hyvo never does, in short, with the contracts that enforce most of it. */
export function TrustBrief() {
  const contracts = [
    { name: "HyvoOracle", address: ADDRESSES.oracle, what: "Holds every run's hash" },
    { name: "PaymentRouter", address: ADDRESSES.paymentRouter, what: "Passes payments to the treasury" },
  ].filter((contract) => contract.address);

  return (
    <section className={shared.section} aria-labelledby="trust-title">
      <Reveal className={shared.head}>
        <h2 id="trust-title">Built to be checked</h2>
        <p>Three of these are enforced by contracts on Robinhood Chain that anyone can read. The trust page shows how to check every one.</p>
      </Reveal>

      <ul className={styles.promises}>
        {PROMISES.map((item, index) => (
          <Reveal as="li" index={index % 3} key={item.never}>
            <h3>
              <span className={styles.never}>Never</span> {item.never.charAt(0).toLowerCase() + item.never.slice(1)}
            </h3>
            <p>{item.how}</p>
          </Reveal>
        ))}
      </ul>

      {(contracts.length > 0 || SOURCE_URL) && (
        <Reveal className={styles.contracts}>
          {contracts.map((contract) => (
            <a key={contract.name} href={addressUrl(contract.address)} target="_blank" rel="noreferrer" className={styles.contract}>
              <span className={styles.contractName}>{contract.name}</span>
              <span className="mono" title={contract.address}>
                {shortHash(contract.address, 6, 4)}
              </span>
              <span className={styles.contractWhat}>{contract.what}</span>
            </a>
          ))}
          {SOURCE_URL && (
            <a href={SOURCE_URL} target="_blank" rel="noreferrer" className={styles.contract}>
              <span className={styles.contractName}>Source</span>
              <span className="mono">AGPL-3.0</span>
              <span className={styles.contractWhat}>The engine and this site</span>
            </a>
          )}
        </Reveal>
      )}

      <div className={shared.links}>
        <Link to="/trust" className="arrow-link" viewTransition>
          Every promise, and how to check it <Arrow />
        </Link>
        <Link to="/oracle" className="arrow-link" viewTransition>
          Check a run on the oracle <Arrow />
        </Link>
      </div>
    </section>
  );
}
