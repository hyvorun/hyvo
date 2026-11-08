/**
 * "What kind of trader are you?": ten questions, each answer pointing at one of the ten
 * archetypes. Every archetype has exactly five answers, so none is favored. Just for fun: the
 * answers describe behavior, and nothing here tells anyone what to trade.
 */
import { PERSONAS } from "@hyvo/schema";
import type { Archetype } from "./archetypes";

export interface QuizOption {
  text: string;
  persona: Archetype;
}

export interface QuizQuestion {
  prompt: string;
  options: QuizOption[];
}

export const QUESTIONS: QuizQuestion[] = [
  {
    prompt: "A new token's pool opened two minutes ago. What do you do first?",
    options: [
      { text: "Get in. The first rounds are the whole game.", persona: "sniper" },
      { text: "Open the contract and the list of holders.", persona: "skeptic" },
      { text: "Check what the big accounts are saying.", persona: "kol_follower" },
      { text: "Wait for the first pullback.", persona: "swing_trader" },
      { text: "Ask a friend what a pool is.", persona: "newcomer" },
    ],
  },
  {
    prompt: "Your position is down 12% in an hour. You…",
    options: [
      { text: "Do nothing. The team is still shipping.", persona: "holder" },
      { text: "Get out. A loss is a loss.", persona: "panic_seller" },
      { text: "Let your rule take a little more, as it does every round.", persona: "market_maker_bot" },
      { text: "Wonder whether you did something wrong.", persona: "newcomer" },
      { text: "Add a little if it holds a higher low.", persona: "swing_trader" },
    ],
  },
  {
    prompt: "How long do you usually stay in?",
    options: [
      { text: "As long as the feed stays excited.", persona: "kol_follower" },
      { text: "One to three rounds. Minutes, not days.", persona: "sniper" },
      { text: "Until the first scare.", persona: "panic_seller" },
      { text: "Weeks to months.", persona: "holder" },
      { text: "Months for what matters. Days for a side bet.", persona: "stock_token_holder" },
    ],
  },
  {
    prompt: "Which post sounds most like yours?",
    options: [
      { text: "“Who holds the top ten wallets?”", persona: "skeptic" },
      { text: "“Rebalanced. Back to target.”", persona: "market_maker_bot" },
      { text: "“In early. Ticker in caps.”", persona: "sniper" },
      { text: "“Is anyone else seeing this drop?”", persona: "panic_seller" },
      { text: "“We're early and we're building. Patience.”", persona: "holder" },
    ],
  },
  {
    prompt: "What makes you leave?",
    options: [
      { text: "A rumor that the dev is out.", persona: "panic_seller" },
      { text: "A run-up deep enough to leave in pieces.", persona: "whale" },
      { text: "Credible signs that the project was abandoned.", persona: "holder" },
      { text: "The loud accounts turning negative.", persona: "kol_follower" },
      { text: "A stall near the highest price so far.", persona: "swing_trader" },
    ],
  },
  {
    prompt: "The token takes 5% of every trade.",
    options: [
      { text: "Wait, there's a fee on every trade?", persona: "newcomer" },
      { text: "Who receives it, and can it change?", persona: "skeptic" },
      { text: "Fine, if the swing is bigger than the fee.", persona: "swing_trader" },
      { text: "That eats every small trade I make.", persona: "market_maker_bot" },
      { text: "Expensive, next to what I already hold.", persona: "stock_token_holder" },
    ],
  },
  {
    prompt: "Your trade size, next to the pool:",
    options: [
      { text: "Quick and early, before the pool gets deep.", persona: "sniper" },
      { text: "Whatever everyone else seems to be doing.", persona: "kol_follower" },
      { text: "Large. I split it so I don't pay my own slippage.", persona: "whale" },
      { text: "Small. I'd rather miss a move than be someone's exit.", persona: "skeptic" },
      { text: "Small and steady, against every move.", persona: "market_maker_bot" },
    ],
  },
  {
    prompt: "Why are you on this chain at all?",
    options: [
      { text: "A community I believe in.", persona: "holder" },
      { text: "A friend sent me a link.", persona: "newcomer" },
      { text: "Tokenized stocks. The rest is a side bet.", persona: "stock_token_holder" },
      { text: "Fresh launches, every day.", persona: "sniper" },
      { text: "Liquidity deep enough for my size.", persona: "whale" },
    ],
  },
  {
    prompt: "Someone posts a screenshot of your wallet.",
    options: [
      { text: "What do they know that I don't?", persona: "panic_seller" },
      { text: "Nothing changes. The rule runs every round.", persona: "market_maker_bot" },
      { text: "Expected. Everyone watches my wallet.", persona: "whale" },
      { text: "Mostly stocks in there. Not much to see.", persona: "stock_token_holder" },
      { text: "Great. Now I'm the big account.", persona: "kol_follower" },
    ],
  },
  {
    prompt: "Pick the line you would say.",
    options: [
      { text: "“What is it actually for?”", persona: "stock_token_holder" },
      { text: "“Levels, not stories.”", persona: "swing_trader" },
      { text: "“Show me the numbers.”", persona: "skeptic" },
      { text: "“Can someone explain this like I'm new?”", persona: "newcomer" },
      { text: "“Size moves slowly.”", persona: "whale" },
    ],
  },
];

export interface QuizResult {
  winner: Archetype;
  /** Answers per archetype, highest first; archetypes with none are left out. */
  ranking: { persona: Archetype; count: number }[];
}

/**
 * The archetype the answers point at most. A tie goes to the archetype among the tied ones that
 * was picked last, so the later answers settle it.
 */
export function scoreQuiz(answers: number[]): QuizResult | null {
  if (answers.length !== QUESTIONS.length) return null;
  const picks: Archetype[] = [];
  for (const [index, answer] of answers.entries()) {
    const option = QUESTIONS[index]?.options[answer];
    if (!option) return null;
    picks.push(option.persona);
  }
  const counts = new Map<Archetype, number>();
  for (const persona of picks) counts.set(persona, (counts.get(persona) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const tied = new Set([...counts].filter(([, count]) => count === top).map(([persona]) => persona));
  const winner = [...picks].reverse().find((persona) => tied.has(persona)) as Archetype;
  const ranking = [...counts]
    .map(([persona, count]) => ({ persona, count }))
    .sort((a, b) => b.count - a.count || (a.persona === winner ? -1 : b.persona === winner ? 1 : PERSONAS.indexOf(a.persona) - PERSONAS.indexOf(b.persona)));
  return { winner, ranking };
}
