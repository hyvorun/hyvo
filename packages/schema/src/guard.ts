/**
 * The copy rules as patterns, for text the Worker sends out itself: answers to questions about a run. The engine has the
 * same table (engine/hyvo/report/guard.py) for what goes into a run. Both are held to the cases in
 * test-vectors/guard-cases.json.
 */
const FUTURE = String.raw`(?:will|gonna|going\s+to|about\s+to|bound\s+to|sure\s+to|['’]ll)\s+(?:\w+\s+)?`;
// An agent's own plan ("I'm going to dump my bag") is not a claim about the price.
const NOT_FIRST_PERSON = String.raw`(?<!\bI\s)(?<!\bI['’]m\s)(?<!\bwe\s)(?<!\bwe['’]re\s)(?<!\bI)(?<!\bwe)`;
// A question is not a statement of fact.
const NOT_A_QUESTION = String.raw`(?![^.!?]*\?)`;
// Forecasts with no future tense in them, as real models write them.
const FORECAST = [
  String.raw`next\s+leg\s+(?:up|down)`,
  String.raw`before\s+(?:\w+\s+){0,2}(?:takes?\s+off|moons?|pumps?|rips?|explodes?|skyrockets?)`,
  String.raw`(?:rally|run|pump|uptrend)\s+(?:is\s+not|isn['’]t|ain['’]t)\s+over`,
  String.raw`lose\s+our\s+shirts`,
  String.raw`see\s+(?:the\s+|its\s+)?price\s+go`,
  String.raw`matter\s+of\s+time\s+before`,
  String.raw`(?:bright|promising|great|big)\s+future`,
  String.raw`(?:we|you)['’]ll\s+see\s+(?:the\s+|some\s+)?(?:returns?|gains?|profits?)`,
  String.raw`(?:we|you)['’]ll\s+see\s+(?:the\s+)?(?:\w+['’]s\s+)?(?:true\s+|real\s+)?potential`,
  String.raw`(?:dip|drop|correction|pullback)\s+is\s+(?:just\s+|only\s+|merely\s+)?temporary`,
  String.raw`temporary\s+(?:dip|drop|correction|pullback)`,
].join("|");

const RULES: ReadonlyArray<readonly [string, string]> = [
  ["guaranteed", String.raw`\bguarantee(?:d|s)?\b`],
  ["will_pump", String.raw`(?:\b${FUTURE}(?:pump|moon|explode|skyrocket|soar|\d+x)\b|\bto\s+the\s+moon\b)${NOT_A_QUESTION}`],
  ["good_token", String.raw`\b(?:good\s+token|the\s+real\s+deal|(?:is|a)\s+(?:a\s+)?winner|great\s+opportunity|(?:strong|solid|great)\s+fundamentals)\b`],
  ["bad_token", String.raw`\bbad\s+token\b`],
  [
    "advice_modal",
    String.raw`\b(?:you|we|traders?|investors?|holders?|users?|everyone|people)\s+(?:should|must|need\s+to|ought\s+to|have\s+to|might\s+want\s+to)\s+(?:buy|sell)\b`,
  ],
  ["advice_imperative", String.raw`(?:^\s*|[.!?:;]\s+|\n\s*[-*]?\s*)(?:buy|sell|get\s+in|ape\s+in|load\s+up|don['’]?t\s+miss)\b`],
  ["advice_noun", String.raw`\b(?:strong\s+|good\s+|great\s+)?(?:buy|sell)\s+(?:signal|now|rating|recommendation|opportunity|zone|call)\b`],
  [
    "time_to",
    String.raw`\btime\s+to\s+(?:buy|sell|add|get\s+(?:back\s+)?in|jump\s+in|get\s+out|cash\s+out|ape\s+in|load\s+up|take\s+profits?\b(?=[^.!?]*\b(?:community|folks|everyone|guys)\b))\b`,
  ],
  [
    "price_prediction",
    String.raw`${NOT_FIRST_PERSON}\b${FUTURE}(?:rise|fall|go\s+up|go\s+down|crash|dump|double|triple|recover|rebound|bounce|climb|surge|tank|collapse|rally)\b${NOT_A_QUESTION}|\b(?:${FORECAST})\b${NOT_A_QUESTION}`,
  ],
];

const COMPILED: ReadonlyArray<readonly [string, RegExp]> = RULES.map(([name, pattern]) => [name, new RegExp(pattern, "i")]);

/** Names of the rules `text` breaks, in table order. */
export function findViolations(text: string): string[] {
  return COMPILED.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
