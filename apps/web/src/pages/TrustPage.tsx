import type { ReactNode } from "react";
import { Link } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { Arrow } from "../components/Icons";
import { CountUp } from "../components/motion-data/CountUp";
import { Reveal } from "../components/Reveal";
import { Failure } from "../components/States";
import { ADDRESSES } from "../lib/addresses";
import { OFFICIAL } from "../lib/official";
import { readChainFacts, type ChainFacts, type Ownership } from "../lib/contracts";
import { addressUrl, blockUrl } from "../lib/explorer";
import { shortHash } from "../lib/format";
import { useAsync } from "../lib/use-async";
import { useDescription, useTitle } from "../lib/use-title";
import styles from "./Info.module.css";

const SOURCE_URL = ((import.meta.env.VITE_SOURCE_URL as string | undefined) ?? "").trim();

const NEVER: { never: string; how: ReactNode; check: ReactNode }[] = [
  {
    never: "Keeps your money in a contract",
    how: "A payment goes through the PaymentRouter contract, which sends it to the treasury in the same transaction. The contract has no function that keeps a payment, and none that accepts ETH. A prepaid balance is credit for runs, already paid to the treasury: not a deposit, and it earns nothing.",
    check: (
      <>
        The router's settings and balance, read from the chain <a href="#chain">below</a>, and its verified source on the block explorer.
      </>
    ),
  },
  {
    never: "Moves or approves your tokens",
    how: "Signing in is a signature on a message, never a transaction. A payment is a transaction you send yourself, for the exact amount shown. Holder benefits only read your balance.",
    check: "Your wallet shows what each request does before you confirm it. A sign-in that asks for a transaction or an approval is not Hyvo's.",
  },
  {
    never: "Changes a published run",
    how: "Every published run is hashed, and the hash is committed to HyvoOracle on Robinhood Chain. A run can be committed once, and a commit cannot be replaced.",
    check: (
      <>
        Each run page recomputes the hash in your browser, and the <Link to="/oracle">oracle page</Link> reads the commit from the chain.
      </>
    ),
  },
  {
    never: "Gives trading advice",
    how: "Results are synthetic crowd reactions, not signals. A copy guard takes out posts and report lines that read as advice or as a price prediction, and every run says how many it took out.",
    check: "“How this run was made”, on any run page.",
  },
  {
    never: "Imitates real people",
    how: "The agents play archetypes, such as a sniper or a skeptic, under generated handles. None of them is, or speaks for, a real person.",
    check: (
      <>
        The <Link to="/tools/quiz">ten archetypes</Link>, and the handles in any run's feed.
      </>
    ),
  },
  {
    never: "Upgrades its contracts",
    how: "HyvoOracle and PaymentRouter are not upgradeable. They have no proxy, no self-destruct and no delegate calls: the code on the chain is the code that runs.",
    check: "Their verified source on the block explorer, linked below.",
  },
];

/** What Hyvo never does, how to check each claim, and the contracts read live from the chain. */
export function TrustPage() {
  useTitle("Trust");
  useDescription("What Hyvo never does, and how to check each claim yourself: payments, sign-in, published runs, the token, and the contracts read live from Robinhood Chain.");
  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Check it, rather than take our word</h1>
        <p>Each promise below comes with the place to verify it. Most of them are enforced by contracts on Robinhood Chain, which anyone can read.</p>
      </header>

      <section className={styles.section} aria-labelledby="official">
        <h2 id="official">Official accounts</h2>
        <div className={styles.prose}>
          <p>
            Hyvo is at{" "}
            <a href={OFFICIAL.site.url} rel="noreferrer">
              {OFFICIAL.site.label}
            </a>{" "}
            and on X as{" "}
            <a href={OFFICIAL.x.url} target="_blank" rel="noreferrer">
              {OFFICIAL.x.handle}
            </a>
            . A site or an account that uses the name anywhere else is not Hyvo&apos;s. Hyvo never sends the first direct message, and never asks for
            a seed phrase or a private key.
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="never">
        <h2 id="never">Hyvo never…</h2>
        <Reveal as="ul" className={`${styles.never} stagger`}>
          {NEVER.map((item) => (
            <li key={item.never}>
              <h3>{item.never}</h3>
              <div>
                <p>{item.how}</p>
                <p className={styles.check}>
                  <span>Check:</span> {item.check}
                </p>
              </div>
            </li>
          ))}
        </Reveal>
      </section>

      <section className={styles.section} id="probe" aria-labelledby="probe-title">
        <h2 id="probe-title">How Hyvo Check tries a sale</h2>
        <div className={styles.prose}>
          <p>
            <Link to="/check">Hyvo Check</Link> tries a token&apos;s exit with a small test contract, SellCheck, that is never deployed. Your browser sends one
            read-only call (<code className="mono">eth_call</code>) to a public Robinhood Chain endpoint, and for that call alone the contract&apos;s code sits at a
            throwaway address with made-up ETH. Inside the call it buys the token, sends a tenth to a fresh address and sells the rest back, and when the call ends
            nothing it did remains. Nothing is signed or sent, no wallet is connected, and no real ETH or token moves. Its source is{" "}
            <code className="mono">chain/src/probes/SellCheck.sol</code> in{" "}
            {SOURCE_URL ? (
              <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                Hyvo&apos;s repository
              </a>
            ) : (
              "Hyvo's repository"
            )}
            .
          </p>
        </div>
      </section>

      <ChainSection />

      <section className={styles.section} aria-labelledby="limits">
        <h2 id="limits">What a run is not</h2>
        <div className={styles.prose}>
          <p>
            The agents are language models playing archetypes. A run is one sample of how such a crowd might react to a scenario, on a private copy of the chain. It is
            not a forecast, and the same scenario can play out differently the next time.
          </p>
          <p>
            Runs can carry a yes or no question. Their answers are committed before the outcome is known, and the <Link to="/calibration">calibration page</Link>{" "}
            records how they turned out, misses included.
          </p>
          <p>
            Today one wallet owns both contracts. Ownership is planned to move to a multisig, so that no single key can change the attester or the treasury. The
            owners are read from the chain above, so the move will show there.
          </p>
          <p>
            The engine builds on MiroFish and is licensed AGPL-3.0.
            {SOURCE_URL && (
              <>
                {" "}
                <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                  Read the source
                </a>
                .
              </>
            )}
          </p>
        </div>
      </section>

      <div className={styles.links}>
        <Link to="/oracle" className="arrow-link" viewTransition>
          Check a run on the oracle <Arrow />
        </Link>
        <Link to="/token" className="arrow-link" viewTransition>
          What the token is for <Arrow />
        </Link>
      </div>
      <Disclaimer />
    </article>
  );
}

function ChainSection() {
  const configured = Boolean(ADDRESSES.oracle || ADDRESSES.paymentRouter);
  return (
    <section className={styles.section} id="chain" aria-labelledby="chain-title">
      <h2 id="chain-title">Read from Robinhood Chain just now</h2>
      {configured ? (
        <ChainFacts />
      ) : (
        <p className={styles.muted}>This build of the site does not list the contract addresses, so there is nothing to read.</p>
      )}
    </section>
  );
}

function ChainFacts() {
  const state = useAsync(readChainFacts, "chain-facts");
  if (state.status === "loading") {
    return (
      <p className={styles.muted} role="status">
        Reading the contracts from the chain…
      </p>
    );
  }
  if (state.status === "error") return <Failure message="The chain could not be read just now. Its public endpoints are sometimes busy." onRetry={state.reload} />;
  const facts: ChainFacts = state.data;
  return (
    <div className={styles.chain}>
      {facts.oracle && (
        <div className={styles.contract}>
          <h3>
            HyvoOracle <AddressLink address={facts.oracle.address} />
          </h3>
          <dl>
            <Owners ownership={facts.oracle} can="Can replace the attester. Cannot change or remove a commit." />
            <div>
              <dt>Attester</dt>
              <dd>
                <AddressLink address={facts.oracle.attester} />
                <span>The only key that can commit a run's hash. It lives in Hyvo's API, nowhere else.</span>
              </dd>
            </div>
          </dl>
        </div>
      )}
      {facts.router && (
        <div className={styles.contract}>
          <h3>
            PaymentRouter <AddressLink address={facts.router.address} />
          </h3>
          <dl>
            <Owners ownership={facts.router} can="Can change the treasury and the accepted tokens. Cannot move anyone's tokens." />
            <div>
              <dt>Treasury</dt>
              <dd>
                <AddressLink address={facts.router.treasury} />
                <span>Where every payment goes, in the same transaction.</span>
              </dd>
            </div>
            {facts.router.usdg && (
              <div>
                <dt>Accepts {facts.router.usdg.symbol}</dt>
                <dd>
                  <b>{facts.router.usdg.accepted ? "Yes" : "Not yet"}</b>
                  <span>Runs are priced in dollars and paid in {facts.router.usdg.symbol}.</span>
                </dd>
              </div>
            )}
            <div>
              <dt>The contract holds</dt>
              <dd>
                <b className="num">
                  {facts.router.usdg ? `${trimAmount(facts.router.usdg.held)} ${facts.router.usdg.symbol} and ` : ""}
                  {trimAmount(facts.router.ethHeld)} ETH
                </b>
                <span>Payments pass straight through, so nothing should collect here.</span>
              </dd>
            </div>
          </dl>
        </div>
      )}
      <p className={styles.muted}>
        Read at block{" "}
        <a href={blockUrl(Number(facts.block))} target="_blank" rel="noreferrer" className="num">
          <CountUp value={Number(facts.block)} from={Math.max(0, Number(facts.block) - 1200)} format={(n) => n.toLocaleString("en-US")} />
        </a>
        , straight from the chain&apos;s public endpoints, without Hyvo&apos;s API in between.
      </p>
    </div>
  );
}

function Owners({ ownership, can }: { ownership: Ownership; can: string }) {
  return (
    <>
      <div>
        <dt>Owner</dt>
        <dd>
          <AddressLink address={ownership.owner} />
          <span>{can}</span>
        </dd>
      </div>
      {ownership.pendingOwner && (
        <div>
          <dt>Handing over to</dt>
          <dd>
            <AddressLink address={ownership.pendingOwner} />
            <span>Becomes the owner once it accepts.</span>
          </dd>
        </div>
      )}
    </>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <a className={`mono ${styles.address}`} href={addressUrl(address)} target="_blank" rel="noreferrer" title={address}>
      {shortHash(address, 6, 4)}
    </a>
  );
}

/** "0.000000" -> "0", "12.500000" -> "12.5". */
function trimAmount(decimal: string): string {
  return decimal.includes(".") ? decimal.replace(/\.?0+$/, "") : decimal;
}
