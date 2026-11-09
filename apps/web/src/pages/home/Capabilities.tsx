import type { HealthResponse } from "@hyvo/schema";
import { Link } from "react-router";
import { Reveal } from "../../components/Reveal";
import styles from "./Capabilities.module.css";
import shared from "./Section.module.css";

type Features = HealthResponse["features"];

/** What decides whether a part is open: nothing, or one of the switches the API reports. */
type Gate = "always" | "oracle" | "payments" | "clone" | "read";

interface Capability {
  name: string;
  line: string;
  who: string;
  to: string;
  gate: Gate;
}

const CAPABILITIES: Capability[] = [
  {
    name: "Simulations",
    line: "Put a token launch, a rumor or a listing in front of a crowd. Choose its size, its mix, its rounds and the events.",
    who: "Launch teams, traders",
    to: "/new",
    gate: "payments",
  },
  {
    name: "Replays",
    line: "Every published run, played back: the price, the feed and the trades in sync, with a scrubber.",
    who: "Everyone",
    to: "/runs",
    gate: "always",
  },
  {
    name: "Oracle",
    line: "Every published run's hash, committed on Robinhood Chain and checked again in your browser.",
    who: "Everyone, and contracts",
    to: "/oracle",
    gate: "oracle",
  },
  {
    name: "Questions",
    line: "Give a run a yes-or-no question. Every agent answers before the outcome is known, and a public record keeps score, misses included.",
    who: "Researchers",
    to: "/calibration",
    gate: "payments",
  },
  {
    name: "Ask an agent",
    line: "Ask one agent of a published run why it did what it did. Its answer passes the same copy rules as the run.",
    who: "Everyone",
    to: "/docs#ask",
    gate: "payments",
  },
  {
    name: "Dry Run",
    line: "Synthetic users try your contract in a private sandbox before mainnet. The report shows reverts, broken invariants and gas outliers. It is not an audit.",
    who: "Developers",
    to: "/dryrun",
    gate: "payments",
  },
  {
    name: "Rewind",
    line: "Fork a past block, change one event, and see the crowd's path beside what really happened after it.",
    who: "Traders, researchers",
    to: "/rewind",
    gate: "payments",
  },
  {
    name: "Wallet Clone",
    line: "Your own wallet's trading style, built from its numbers alone, joins a crowd as one agent. Only a wallet you sign in with.",
    who: "Traders",
    to: "/clone",
    gate: "clone",
  },
  {
    name: "API, MCP and webhooks",
    line: "For programs and AI agents: list, read and verify runs without a key; start runs and ask agents with one.",
    who: "Bots, AI agents",
    to: "/docs",
    gate: "read",
  },
  {
    name: "Free tools",
    line: "Swap and price impact, impermanent loss, market cap, units, checklists, a glossary and a quiz.",
    who: "Everyone",
    to: "/tools",
    gate: "always",
  },
];

type Status = { tone: "live" | "later"; text: string };

/** Whether a part is open, from the switches the API reports. Unknown until it answers. */
export function capabilityStatus(gate: Gate, features: Features | null): Status | null {
  if (gate === "always") return { tone: "live", text: "Live" };
  if (!features) return null;
  switch (gate) {
    case "oracle":
      return features.oracle ? { tone: "live", text: "Live" } : { tone: "later", text: "Not open yet" };
    case "payments":
      return features.payments ? { tone: "live", text: "Live" } : { tone: "later", text: "Opens with paid runs" };
    case "clone":
      if (!features.clone) return { tone: "later", text: "Not open yet" };
      return features.payments ? { tone: "live", text: "Live" } : { tone: "later", text: "Opens with paid runs" };
    case "read":
      return features.payments ? { tone: "live", text: "Live" } : { tone: "live", text: "Live for reading" };
  }
}

/** Every part of Hyvo in one list: what it does, who it is for, and whether it is open today. */
export function Capabilities({ features, loading }: { features: Features | null; loading: boolean }) {
  const statuses = CAPABILITIES.map((item) => capabilityStatus(item.gate, features));
  // When the API cannot say what is open, the list says nothing about it rather than half of it.
  const showStatus = features !== null || loading;
  const lead =
    features === null
      ? "Watching runs and checking their hashes never needs a wallet."
      : statuses.every((status) => status?.text === "Live")
        ? "All of it is open, and watching runs or checking their hashes never needs a wallet."
        : "Whatever is marked Live is open today, and watching runs or checking their hashes never needs a wallet.";

  return (
    <section className={shared.section} aria-labelledby="capabilities-title">
      <Reveal className={shared.head}>
        <h2 id="capabilities-title">What you can do with Hyvo</h2>
        <p>{lead}</p>
      </Reveal>
      <div className={styles.table}>
        <div className={styles.columns} aria-hidden="true">
          <span>Part</span>
          <span>What it does</span>
          <span>For</span>
          {showStatus && <span>Today</span>}
        </div>
        <ul className={styles.rows}>
          {CAPABILITIES.map((item, index) => {
            const status = statuses[index];
            return (
              <Reveal as="li" index={index % 4} key={item.name} className={styles.row}>
                <h3 className={styles.name}>
                  <Link to={item.to} viewTransition>
                    {item.name}
                  </Link>
                </h3>
                <p className={styles.line}>{item.line}</p>
                <p className={styles.who}>
                  <span className="visually-hidden">For: </span>
                  {item.who}
                </p>
                {showStatus && (
                  <p className={styles.status} data-tone={status?.tone ?? "unknown"}>
                    {status ? (
                      <>
                        <span className={styles.dot} aria-hidden="true" />
                        {status.text}
                      </>
                    ) : (
                      <span className={`${styles.wait} skeleton`} aria-hidden="true" />
                    )}
                  </p>
                )}
                <span className={styles.chevron} aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <path d="M6 3.5 10.5 8 6 12.5" />
                  </svg>
                </span>
              </Reveal>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
