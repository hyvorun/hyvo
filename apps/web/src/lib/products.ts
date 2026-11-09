/**
 * Every Hyvo product in one list: the home page, the products page, the header and the footer read
 * it. Whether a product is open comes from the switches the API reports (`GET /v1/health`), never
 * from this file.
 */
import type { HealthResponse } from "@hyvo/schema";

export type Features = HealthResponse["features"];

/** What decides whether a product is open: nothing, or one of the API's switches. */
export type Gate = "always" | "oracle" | "payments" | "clone" | "read";

/** The kinds of job a product does, in the order the products page shows them. */
export const GROUPS = [
  { id: "simulate", name: "Simulate", line: "Try something on a private copy of the chain before it is real." },
  { id: "verify", name: "Verify", line: "Check what a run did, and that nobody changed it since." },
  { id: "build", name: "Build", line: "Use Hyvo from programs, bots and AI agents." },
  { id: "learn", name: "Learn", line: "Free tools for the arithmetic and the words around a launch." },
] as const;

export type GroupId = (typeof GROUPS)[number]["id"];

export interface Product {
  id: string;
  name: string;
  /** What it does, in one or two plain sentences. */
  line: string;
  who: string;
  to: string;
  group: GroupId;
  gate: Gate;
}

export const PRODUCTS: Product[] = [
  {
    id: "simulations",
    name: "Simulations",
    line: "Put a token launch, a rumor or a listing in front of a crowd. Choose its size, its mix, its rounds and the events.",
    who: "Launch teams, traders",
    to: "/new",
    group: "simulate",
    gate: "payments",
  },
  {
    id: "replays",
    name: "Replays",
    line: "Every published run, played back: the price, the feed and the trades in sync, with a scrubber.",
    who: "Everyone",
    to: "/runs",
    group: "verify",
    gate: "always",
  },
  {
    id: "oracle",
    name: "Oracle",
    line: "Every published run's hash, committed on Robinhood Chain and checked again in your browser.",
    who: "Everyone, and contracts",
    to: "/oracle",
    group: "verify",
    gate: "oracle",
  },
  {
    id: "questions",
    name: "Questions",
    line: "Give a run a yes-or-no question. Every agent answers before the outcome is known, and a public record keeps score, misses included.",
    who: "Researchers",
    to: "/calibration",
    group: "simulate",
    gate: "payments",
  },
  {
    id: "ask",
    name: "Ask an agent",
    line: "Ask one agent of a published run why it did what it did. Its answer passes the same copy rules as the run.",
    who: "Everyone",
    to: "/docs#ask",
    group: "simulate",
    gate: "payments",
  },
  {
    id: "dryrun",
    name: "Dry Run",
    line: "Synthetic users try your contract in a private sandbox before mainnet. The report shows reverts, broken invariants and gas outliers. It is not an audit.",
    who: "Developers",
    to: "/dryrun",
    group: "simulate",
    gate: "payments",
  },
  {
    id: "rewind",
    name: "Rewind",
    line: "Fork a past block, change one event, and see the crowd's path beside what really happened after it.",
    who: "Traders, researchers",
    to: "/rewind",
    group: "simulate",
    gate: "payments",
  },
  {
    id: "clone",
    name: "Wallet Clone",
    line: "Your own wallet's trading style, built from its numbers alone, joins a crowd as one agent. Only a wallet you sign in with.",
    who: "Traders",
    to: "/clone",
    group: "simulate",
    gate: "clone",
  },
  {
    id: "api",
    name: "API, MCP and webhooks",
    line: "For programs and AI agents: list, read and verify runs without a key; start runs and ask agents with one.",
    who: "Bots, AI agents",
    to: "/docs",
    group: "build",
    gate: "read",
  },
  {
    id: "tools",
    name: "Free tools",
    line: "Swap and price impact, impermanent loss, market cap, units, checklists, a glossary and a quiz.",
    who: "Everyone",
    to: "/tools",
    group: "learn",
    gate: "always",
  },
];

export type Status = { tone: "live" | "later"; text: string };

/** Whether a product is open, from the switches the API reports. Unknown until it answers. */
export function productStatus(gate: Gate, features: Features | null): Status | null {
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
