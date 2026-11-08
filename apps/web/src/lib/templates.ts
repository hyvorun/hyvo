/**
 * Example scenarios for /new: a starting point a person edits, not a run anyone published. Every
 * token is fictional and every handle a role; none names a real project, person or exchange.
 */
import type { Draft, DraftEvent } from "./draft";

export interface Template {
  id: string;
  label: string;
  /** What the example tests, in a few words. */
  tests: string;
  draft: Pick<Draft, "title" | "seedText" | "tokenSymbol" | "tokenName" | "liquidityEth" | "feePct"> & { events: DraftEvent[] };
}

export const TEMPLATES: Template[] = [
  {
    id: "creator-tax",
    label: "Creator tax",
    tests: "How a crowd takes a 5% tax",
    draft: {
      title: "Fictional token FIZZ launches with a 5% creator tax",
      seedText:
        "FIZZ is a new, fictional token. Its launch post says 5% of every trade goes to the creator to fund development. The team is two pseudonymous developers with a public repository. Liquidity starts at 5 ETH and the creator holds 8% of the supply.",
      events: [
        { round: "3", text: "A skeptical account asks why the tax is 5% and whether it can change." },
        { round: "6", text: "The creator replies that the tax is fixed in the contract and posts the line of code." },
      ],
      tokenSymbol: "FIZZ",
      tokenName: "Fizz (fictional)",
      liquidityEth: "5",
      feePct: "5",
    },
  },
  {
    id: "rumor",
    label: "Rumor",
    tests: "A rumor, then the facts",
    draft: {
      title: "A rumor says the developer of fictional MOTH has left",
      seedText:
        "MOTH is a fictional token that launched two days ago and has a small, active community. Liquidity is 4 ETH. The developer posts every day, and the community account answers questions quickly.",
      events: [
        { round: "3", text: "An anonymous account claims the developer's wallet moved its tokens out." },
        { round: "5", text: "The developer posts the wallet history: the tokens moved to a vesting contract, not to a sale." },
      ],
      tokenSymbol: "MOTH",
      tokenName: "Moth (fictional)",
      liquidityEth: "4",
      feePct: "1",
    },
  },
  {
    id: "whale",
    label: "Whale exit",
    tests: "A large holder leaves",
    draft: {
      title: "A whale starts leaving fictional ORBIT",
      seedText:
        "ORBIT is a fictional token with steady activity for a week. One wallet holds 12% of the supply and has not moved since launch. Liquidity is 10 ETH.",
      events: [
        { round: "4", text: "The large wallet moves a third of its tokens out in three trades." },
        { round: "7", text: "The same wallet posts: 'Taking some off, still holding the rest.'" },
      ],
      tokenSymbol: "ORBIT",
      tokenName: "Orbit (fictional)",
      liquidityEth: "10",
      feePct: "1",
    },
  },
  {
    id: "hype",
    label: "Hype",
    tests: "A loud account, then a reversal",
    draft: {
      title: "A popular account hypes fictional GLOW, then turns on it",
      seedText: "GLOW is a fictional token one hour old. Liquidity is 3 ETH, and only a few dozen wallets hold it so far.",
      events: [
        { round: "2", text: "An account with a large following posts that GLOW is the next big thing." },
        { round: "6", text: "The same account posts that it is out of GLOW and moving on." },
      ],
      tokenSymbol: "GLOW",
      tokenName: "Glow (fictional)",
      liquidityEth: "3",
      feePct: "1",
    },
  },
  {
    id: "thin",
    label: "Thin liquidity",
    tests: "Every trade moves the price",
    draft: {
      title: "Fictional DRIP launches with only 0.5 ETH of liquidity",
      seedText:
        "DRIP is a fictional token. Its creator added just 0.5 ETH of liquidity, so small trades move the price a lot. The launch post promises nothing and links to the contract.",
      events: [{ round: "4", text: "Someone posts a chart showing that one trade moved the price by 20%." }],
      tokenSymbol: "DRIP",
      tokenName: "Drip (fictional)",
      liquidityEth: "0.5",
      feePct: "1",
    },
  },
  {
    id: "claim",
    label: "Unverified claim",
    tests: "News nobody can check",
    draft: {
      title: "Fictional NOVA announces a partnership nobody can verify",
      seedText:
        "NOVA is a fictional token with a week of history and 6 ETH of liquidity. Its team is public and has answered questions openly so far.",
      events: [
        { round: "3", text: "The team announces a partnership with an unnamed large company, without a link or a name." },
        { round: "6", text: "Asked for proof, the team says details come next month." },
      ],
      tokenSymbol: "NOVA",
      tokenName: "Nova (fictional)",
      liquidityEth: "6",
      feePct: "1",
    },
  },
];

/** The latest round any of a template's events needs. */
export function lastEventRound(template: Template): number {
  return Math.max(0, ...template.draft.events.map((event) => Number(event.round)));
}
