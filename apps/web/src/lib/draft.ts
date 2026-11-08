/**
 * The /new form as plain data: what the inputs hold (strings), and the QuoteRequest it becomes.
 * Field errors use the same paths as the API's zod schema, so a refused request lands on the
 * right input.
 */
import { MAX_EVENT_CHARS, MAX_SEED_CHARS, MAX_TITLE_CHARS, PERSONAS, QuoteRequest } from "@hyvo/schema";

export const SIZES = [
  { id: "small", label: "Small", agents: 30, rounds: 10 },
  { id: "medium", label: "Medium", agents: 50, rounds: 10 },
  { id: "large", label: "Large", agents: 80, rounds: 10 },
] as const;

/** The API's default bounds (wrangler.jsonc MIN/MAX_AGENTS, MIN/MAX_ROUNDS); the API has the final say. */
export const BOUNDS = { minAgents: 10, maxAgents: 2000, minRounds: 3, maxRounds: 30 };
export const MAX_FEE_PCT = 10;

export interface DraftEvent {
  round: string;
  text: string;
}

export interface Draft {
  title: string;
  seedText: string;
  events: DraftEvent[];
  tokenSymbol: string;
  tokenName: string;
  liquidityEth: string;
  feePct: string;
  agents: string;
  rounds: string;
  /** Agents per kind of trader, as typed. All empty means the default crowd. */
  mix: Partial<Record<(typeof PERSONAS)[number], string>>;
  listed: boolean;
  question: string;
  /** YYYY-MM-DD, from a date input. */
  questionDate: string;
}

export const EMPTY_DRAFT: Draft = {
  title: "",
  seedText: "",
  events: [],
  tokenSymbol: "",
  tokenName: "",
  liquidityEth: "",
  feePct: "",
  agents: "50",
  rounds: "10",
  mix: {},
  listed: true,
  question: "",
  questionDate: "",
};

export function codePoints(text: string): number {
  return [...text].length;
}

export type FieldErrors = Record<string, string>;

export function toRequest(draft: Draft): { request: QuoteRequest | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const agents = wholeNumber(draft.agents);
  const rounds = wholeNumber(draft.rounds);
  if (agents === null || agents < BOUNDS.minAgents || agents > BOUNDS.maxAgents) {
    errors.agents = `Choose ${BOUNDS.minAgents} to ${BOUNDS.maxAgents.toLocaleString("en-US")} agents.`;
  }
  if (rounds === null || rounds < BOUNDS.minRounds || rounds > BOUNDS.maxRounds) {
    errors.rounds = `Choose ${BOUNDS.minRounds} to ${BOUNDS.maxRounds} rounds.`;
  }
  const mix = mixFrom(draft, errors);
  if (mix && agents !== null) {
    const assigned = Object.values(mix).reduce((sum, count) => sum + count, 0);
    if (assigned !== agents) errors.mix = `The mix adds up to ${assigned}, and the crowd has ${agents} agents.`;
  }

  const title = draft.title.trim();
  if (!title) errors.title = "Give the scenario a title.";
  else if (codePoints(title) > MAX_TITLE_CHARS) errors.title = `Keep the title to ${MAX_TITLE_CHARS} characters.`;
  else if (!/[\p{L}\p{N}]/u.test(title)) errors.title = "The title needs at least one letter or digit.";
  if (codePoints(draft.seedText) > MAX_SEED_CHARS) errors.seedText = `Keep the scenario to ${MAX_SEED_CHARS} characters.`;

  const events = draft.events.map((event, index) => {
    const round = wholeNumber(event.round);
    if (round === null || round < 1) errors[`events.${index}.round`] = "Use a round number from 1.";
    else if (rounds !== null && round > rounds) errors[`events.${index}.round`] = `The run has ${rounds} rounds.`;
    const text = event.text.trim();
    if (!text) errors[`events.${index}.text`] = "Describe what happens, or remove the event.";
    else if (codePoints(text) > MAX_EVENT_CHARS) errors[`events.${index}.text`] = `Keep it to ${MAX_EVENT_CHARS} characters.`;
    return { round: round ?? 0, text };
  });

  const market: Record<string, string | number> = {};
  const symbol = draft.tokenSymbol.trim().toUpperCase();
  if (symbol) {
    if (!/^[A-Z0-9]{1,11}$/.test(symbol)) errors["market.tokenSymbol"] = "Use 1 to 11 letters or digits.";
    market.tokenSymbol = symbol;
  }
  const name = draft.tokenName.trim();
  if (name) {
    if (codePoints(name) > 64) errors["market.tokenName"] = "Keep the name to 64 characters.";
    market.tokenName = name;
  }
  const liquidity = draft.liquidityEth.trim();
  if (liquidity) {
    if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(liquidity) || Number(liquidity) < 0.001 || Number(liquidity) > 1_000_000) {
      errors["market.liquidityEth"] = "Use at least 0.001 ETH, such as 5 or 0.5.";
    }
    market.liquidityEth = liquidity;
  }
  const fee = draft.feePct.trim();
  if (fee) {
    const pct = Number(fee);
    if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(fee) || pct > MAX_FEE_PCT) {
      errors["market.feeBps"] = `Use 0 to ${MAX_FEE_PCT}%, with at most two decimals.`;
    }
    market.feeBps = Math.round(pct * 100);
  }

  const question = draft.question.trim();
  const questionDate = draft.questionDate.trim();
  if (question && codePoints(question) < 10) errors["question.text"] = "Ask it in at least 10 characters.";
  if (question && codePoints(question) > 300) errors["question.text"] = "Keep the question to 300 characters.";
  if (question && !questionDate) errors["question.resolvesAt"] = "Give the question a date.";
  if (!question && questionDate) errors["question.text"] = "Write the question, or clear the date.";
  if (questionDate && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(questionDate)) errors["question.resolvesAt"] = "Use a date such as 2026-12-01.";

  if (Object.keys(errors).length > 0 || agents === null || rounds === null) return { request: null, errors };
  const candidate = {
    scenario: {
      title,
      seedText: draft.seedText.trim(),
      events,
      ...(Object.keys(market).length > 0 ? { market } : {}),
    },
    agents,
    rounds,
    ...(mix ? { mix } : {}),
    listed: draft.listed,
    ...(question ? { question: { text: question, resolvesAt: `${questionDate}T00:00:00Z` } } : {}),
  };
  const parsed = QuoteRequest.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[issue.path.join(".")] ??= issue.message;
    return { request: null, errors };
  }
  return { request: parsed.data, errors };
}

/** How many agents the typed mix assigns so far. */
export function assignedAgents(draft: Draft): number {
  return PERSONAS.reduce((sum, persona) => sum + (wholeNumber(draft.mix[persona] ?? "") ?? 0), 0);
}

function mixFrom(draft: Draft, errors: FieldErrors): Record<string, number> | null {
  const mix: Record<string, number> = {};
  let typed = false;
  for (const persona of PERSONAS) {
    const text = draft.mix[persona]?.trim();
    if (!text) continue;
    typed = true;
    const count = wholeNumber(text);
    if (count === null) errors[`mix.${persona}`] = "Use a whole number.";
    else if (count > 0) mix[persona] = count;
  }
  return typed ? mix : null;
}

function wholeNumber(value: string): number | null {
  const text = value.trim();
  return /^[0-9]{1,6}$/.test(text) ? Number(text) : null;
}

/** A token amount in base units as a short decimal: 1000000 (6 decimals) -> "1.00". */
export function formatTokenAmount(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const cents = ((value % unit) * 100n) / unit;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}
