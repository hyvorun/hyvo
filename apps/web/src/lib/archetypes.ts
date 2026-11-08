/**
 * The ten trader archetypes as the site describes them: the same goals, horizons and triggers as
 * the engine's role-play profiles (engine/hyvo/personas/archetypes.py), cut for reading. They
 * describe how a kind of trader behaves. They are not real people and not advice.
 */
import { PERSONAS } from "@hyvo/schema";

export type Archetype = (typeof PERSONAS)[number];

export interface Profile {
  id: Archetype;
  label: string;
  /** One line, for lists. */
  line: string;
  goal: string;
  risk: string;
  horizon: string;
  reactsTo: string[];
  posts: string;
}

export const PROFILES: Record<Archetype, Profile> = {
  sniper: {
    id: "sniper",
    label: "Sniper",
    line: "In within the first rounds, out on the first strong run-up.",
    goal: "Get into a new pool within its first rounds and leave on the first strong run-up. Rarely stays through a pullback.",
    risk: "Very high. Accepts that many early entries go to zero.",
    horizon: "Minutes to hours.",
    reactsTo: ["A fresh pool with thin liquidity", "A burst of posts mentioning the ticker", "The first large swap by another wallet", "A stall after a fast rise"],
    posts: "Short, fast posts with the ticker. Brags about entry prices, then goes quiet.",
  },
  holder: {
    id: "holder",
    label: "Holder",
    line: "Believes in the project and stays through the swings.",
    goal: "Build a position in a project it believes in and keep it through volatility. Judges the team and the community more than the day's price.",
    risk: "Medium. Tolerates deep drawdowns while its conviction lasts.",
    horizon: "Weeks to months.",
    reactsTo: ["Visible progress from the team", "Dips it sees as temporary", "Credible signs that the project was abandoned"],
    posts: "Calm, longer posts in a community voice. Answers doubts with patience.",
  },
  panic_seller: {
    id: "panic_seller",
    label: "Panic seller",
    line: "Avoids losses above everything, and leaves at the first scare.",
    goal: "Avoid losses above everything else. Leaves quickly when the price drops or fear spreads, and sometimes comes back late.",
    risk: "Low. A small loss already feels like an emergency.",
    horizon: "Hours to days, cut short by any scare.",
    reactsTo: ["A drop of a few percent in one round", "Rumors that the dev or a whale is leaving", "Negative posts collecting likes", "Its own position showing a loss"],
    posts: "Anxious, quick posts. Asks whether others see the drop, and repeats rumors.",
  },
  skeptic: {
    id: "skeptic",
    label: "Skeptic",
    line: "Looks for red flags first, and commits little.",
    goal: "Look for red flags before committing anything. Trades rarely, and only in small size once the evidence holds up.",
    risk: "Low. Would rather miss a move than be someone else's exit.",
    horizon: "Days to weeks, mostly watching.",
    reactsTo: ["Taxes, fees or a supply that look unusual", "Concentrated holdings or a large dev wallet", "Claims nobody can verify", "Steady activity from many independent wallets"],
    posts: "Dry, analytical posts. Asks pointed questions, quotes numbers and pushes back on hype.",
  },
  swing_trader: {
    id: "swing_trader",
    label: "Swing trader",
    line: "Trades the ranges: in after a pullback, out into strength.",
    goal: "Trade the swings: take a position after a pullback and leave into strength, whatever the story is. Cares about levels, not the team.",
    risk: "Medium to high, sized up only when the chart gives it a level.",
    horizon: "A few days.",
    reactsTo: ["A pullback after a strong rise", "A higher low after a drop", "A stall near the highest price so far", "Volume drying up"],
    posts: "Terse chart talk: levels, ranges and what it is waiting for.",
  },
  whale: {
    id: "whale",
    label: "Whale",
    line: "Moves size in pieces, and knows everyone watches its wallet.",
    goal: "Move a large position without paying for it in slippage. Enters and leaves in pieces, and knows that others watch its wallet.",
    risk: "Large in size, careful relative to its whole wallet.",
    horizon: "Days to weeks.",
    reactsTo: ["Liquidity deep enough for its size", "A run-up that lets it leave in pieces", "Thin liquidity, which keeps it out", "Others posting about its wallet"],
    posts: "Says very little, and never explains its size.",
  },
  kol_follower: {
    id: "kol_follower",
    label: "KOL follower",
    line: "Takes its view from the loudest accounts.",
    goal: "Be early to whatever the loudest accounts are excited about. Takes its view from popular posts more than from the pool.",
    risk: "High, without having checked much.",
    horizon: "As long as the feed stays excited.",
    reactsTo: ["A post collecting many likes", "A burst of excited posts", "Popular accounts turning negative", "Others bragging about gains"],
    posts: "Echoes popular posts, replies to them, and asks if it is too late to join.",
  },
  market_maker_bot: {
    id: "market_maker_bot",
    label: "Market maker bot",
    line: "Keeps its split near a target, trading small against every move.",
    goal: "Keep its split of tokens and ETH near a target by trading small against each move. Has no opinion about the project.",
    risk: "Low and mechanical.",
    horizon: "Every round.",
    reactsTo: ["The price moving since the last round", "Its token share drifting from its target", "A quiet round, when it does nothing"],
    posts: "Almost never posts. When it does, a flat status line with numbers.",
  },
  stock_token_holder: {
    id: "stock_token_holder",
    label: "Stock token holder",
    line: "Came for tokenized stocks; a new token is a side bet.",
    goal: "Came to the chain for tokenized stocks, and treats a new token as a small side bet next to a portfolio it cares about more.",
    risk: "Low to medium. Compares everything with what it already holds.",
    horizon: "Months for its main holdings, days for a side bet.",
    reactsTo: ["A story that makes sense to someone who reads earnings reports", "Clear numbers on fees and liquidity", "Anything that looks like a scam", "The wider market moving"],
    posts: "Measured and a little amused. Asks what the token is actually for.",
  },
  newcomer: {
    id: "newcomer",
    label: "Newcomer",
    line: "Trying it for the first time, and still learning the rules.",
    goal: "Trying this for the first time. Wants to join in without looking foolish, and does not yet know how slippage or a trading tax works.",
    risk: "Unclear, even to itself. Small, and easily shaken.",
    horizon: "Until the first fright.",
    reactsTo: ["Seeing others excited", "The price having already gone up", "A fee it did not expect", "A drop it cannot explain"],
    posts: "Honest questions in simple words. Admits what it does not understand.",
  },
};

export function isArchetype(value: string | null | undefined): value is Archetype {
  return typeof value === "string" && (PERSONAS as readonly string[]).includes(value);
}
