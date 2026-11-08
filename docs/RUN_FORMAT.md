# `run.json` format, version 1 (normative)

`run.json` is the canonical artifact of one Hyvo run. The engine (Python, `engine/hyvo`) writes it;
`packages/schema` (TypeScript, zod) validates it; the Worker re-hashes it before committing the hash
on-chain. Both implementations MUST follow this document exactly. Shared test vectors live in
`packages/schema/test-vectors/` and are consumed by both test suites.

## Hashing

```
hash = "0x" + lowercase_hex( keccak256( utf8( JCS( run without the "hash" member ) ) ) )
```

- **JCS** is the JSON Canonicalization Scheme, [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785):
  object members sorted by the UTF-16 code units of their names, no insignificant whitespace,
  strings escaped per RFC 8785 (non-ASCII characters are emitted as UTF-8, not `\u` escapes),
  numbers serialized like ECMAScript `Number.prototype.toString` (so `1.0` → `1`, `1e21` → `1e+21`).
- **keccak256** is the original Keccak-256 used by Ethereum (not NIST SHA3-256).
- Only the top-level `hash` member is removed before hashing. Nothing else is excluded.
- Implementations: Python `rfc8785` + `eth_hash`/`web3.keccak`; TypeScript `canonicalize` +
  `@noble/hashes` `keccak_256`.
- Integers in `run.json` stay far below 2^53. All token and ETH amounts are decimal **strings**, so
  no amount ever goes through a float.

### Derived identifiers (used by the oracle, Phase 3)

- `scenarioHash = keccak256(utf8(JCS(run.scenario)))`, hex as above.
- `reportHash = hash` (the run hash covers the report and everything else).
- `runIdBytes32`: the 26-character ULID after the `run_` prefix decoded from Crockford base32 to its
  128-bit value, written big-endian into the low 16 bytes of a `bytes32` (high 16 bytes zero). It is
  reversible, so a `runId` can be recovered from on-chain events.

## Primitive formats

| Name | Rule |
|---|---|
| `RunId` | `^run_[0-9A-HJKMNP-TV-Z]{26}$` (ULID, uppercase Crockford base32) |
| `Timestamp` | UTC, seconds precision: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$` |
| `Address` | `^0x[0-9a-fA-F]{40}$` (engine writes EIP-55 checksummed addresses) |
| `TxHash`, `Hash32` | `^0x[0-9a-f]{64}$` (lowercase) |
| `Decimal` | non-negative decimal string in whole units, no exponent, no leading zeros, no trailing fractional zeros: `^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$` (e.g. `"0"`, `"10"`, `"0.05"`; never `"1.50"` or `".5"`) |
| `AgentId` | `^a[0-9]{2,4}$`, zero-padded to `max(2, digits(size))` (e.g. `a07`) |
| `PostId` | `^[pc][0-9]+$`: `p<n>` for a top-level post, `c<n>` for a reply (comment) |
| `Handle` | `^@[a-z0-9_]{3,30}$`, generated, never a real person |

Amounts convert from integer base units exactly (`wei / 10^decimals`, trimmed). `price` is
`reserveQuote / reserveToken` (quote = WETH, so ETH per token), computed with Python `Decimal` at
40 significant digits, rounded half-even to 18 fractional digits, then trimmed to the `Decimal`
format above.

## Document

```jsonc
{
  "runId": "run_01JC8Z6Q3W1Y2V9K7T5R4N3M2P",
  "version": 1,
  "createdAt": "2026-11-03T10:00:00Z",
  "status": "complete",            // "complete" | "partial" (stopped by budget or timeout)
  "stopReason": null,              // null | "max_cost_usd" | "max_llm_calls" | "timeout"
  "scenario": {
    "title": "…",                  // 1..200 chars
    "seedText": "…",               // 0..4000 chars, already sanitized
    "seedSources": [ { "kind": "user", "ref": "…" } ],      // kind: "url" | "onchain" | "user"
    "injectedEvents": [ { "round": 4, "text": "…" } ]       // round >= 1, text 1..500 chars
  },
  "world": {
    "chainId": 4663,
    "forkBlock": 12345678,         // integer, or null when anvil ran without a fork
    "pools": [ { "address": "0x…", "token0": "0x…", "token1": "0x…", "kind": "v2-test", "feeBps": 30 } ],
    "token": { "address": "0x…", "symbol": "HYVX", "name": "…", "decimals": 18 },
    "quote": { "address": "0x…", "symbol": "WETH", "decimals": 18 },
    "initialMarket": { "price": "0.0001", "reserve0": "…", "reserve1": "…", "holders": 15 }
  },
  "crowd": {
    "size": 50,
    "personaMix": { "sniper": 10, "holder": 15, "panic_seller": 10, "skeptic": 15 },   // sums to size
    "model": { "agents": "provider/model", "report": "provider/model", "temperature": 0.8 },
    "agents": [ { "agentId": "a01", "handle": "@quietferret42", "persona": "holder",
                  "startEth": "0.8", "startTokens": "10000" } ]                    // length == size
  },
  "rounds": [
    {
      "n": 1,                      // 1..R, consecutive
      "posts": [ { "id": "p12", "agentId": "a07", "text": "…", "replyTo": null, "likes": 3 } ],
      "actions": [
        { "agentId": "a07", "kind": "swap_buy", "amountIn": "0.05", "amountOut": "41234.5",
          "txHash": "0x…", "status": "ok", "note": null }
      ],
      "market": { "price": "0.000123", "reserve0": "…", "reserve1": "…", "holders": 41 }
    }
  ],
  "report": {
    "summary": "…",
    "turningPoint": { "round": 6, "why": "…" },     // or null
    "sentimentByRound": [0.4, 0.5],                 // one per round, each in [-1, 1]
    "objections": [ "…" ],
    "priceDrivers": [ "…" ],                        // what moved price
    "disclaimer": "Synthetic crowd reaction. Not a trading signal.",
    "flags": [ ]                                    // copy-guard notes (banned phrases rewritten)
  },
  "usage": { "llmCalls": 57, "inputTokens": 123456, "outputTokens": 23456, "costUsd": 0.0312 },
  "hash": "0x…"
}
```

### Field rules

- `posts[].likes` is the total likes the post had at the end of the run. `replyTo` is `null` or the
  `id` of an earlier post in the same run.
- `actions[]` holds one entry per agent per round (its market decision for that round).
  - `kind`: `swap_buy` | `swap_sell` | `hold` | `check_market`.
  - `swap_buy`: `amountIn` = ETH spent, `amountOut` = tokens received.
    `swap_sell`: `amountIn` = tokens sold, `amountOut` = ETH received.
    `hold` / `check_market`: both `null`.
  - `status`: `ok` (executed, or a no-op that needed no tx), `reverted` (tx sent and reverted, e.g.
    slippage), `invalid` (rejected by validation and converted to `hold`; `kind` is then `hold` and
    `note` says why).
  - `txHash` is set for every swap that was sent (`ok` or `reverted`), otherwise `null`.
- `market` is the state after all of the round's actions: `reserve0`/`reserve1` follow
  `world.pools[0].token0`/`token1`; `holders` counts agent addresses with a token balance > 0.
- `world.initialMarket` is the pool before round 1 (after deploy, initial liquidity and agent token
  seeding), in the same format. `crowd.agents[].startEth`/`startTokens` are each agent's balances at
  that moment, and `initialMarket.holders` equals the number of agents with `startTokens > 0`.
  Together they make a run fully replayable by a third party: starting from `initialMarket`, apply
  every round's `ok` swaps in order with the pool formula (`chain/src/test-assets/HyvoV2Router.sol`
  `getAmountOut`) to get each round's reserves and price, and track each agent's balances from its
  start balances to get `holders` (gas is zero on the per-job chain, so balances move only by swaps;
  no balance may go negative). `engine/hyvo/world/verify.py` `check_run_market` is the reference.
- `report.disclaimer` is exactly `Synthetic crowd reaction. Not a trading signal.`
- `usage.costUsd` is a float rounded to 6 decimals; offline models cost 0.

### Clarifications (enforced identically by pydantic and zod)

- `RunId`: the first ULID character is `0`-`7` (a ULID is 128 bits).
- Integers are JSON integers (`2`, never `2.0`) in `[-(2^53-1), 2^53-1]`.
- `Timestamp` must be a real instant: no hour 24, no second 60, no impossible dates.
- A `c…` post has a non-null `replyTo`; a `p…` post has `replyTo: null`. "Earlier" means earlier in
  document order (rounds in order, posts in array order).
- `status: "complete"` ⇒ `stopReason: null`. `turningPoint.round` ≤ number of rounds.
- `reverted` swaps carry a `txHash`; their amounts may be `null`.
- `personaMix` always lists all four Stage 1 personas (`sniper`, `holder`, `panic_seller`, `skeptic`), and a later one (`swing_trader`, `whale`,
  `kol_follower`, `market_maker_bot`, `stock_token_holder`, `newcomer`) only when the crowd has it, so a run from before them reads and hashes as it did;
  zero counts are allowed. Adding them kept `version: 1`, like `question`: every run that was valid stays valid, with the same hash.
- `rewind` is optional, and present only on a run that replays a real moment (`docs/API.md`, "Rewind"): `pool`, `block` (equal to `world.forkBlock`), `at`, `hours`, `change`, and `actual`, the real pool's `block`, `at`, `price`,
  `reserveEth` and `reserveToken` from that block on, read from the chain before the run started. Without it, a run hashes as it always has.
- `persona: "clone"` is an agent that trades by one wallet's numbers. A run has at most one, counted as `personaMix.clone`. The file holds what it did, not the numbers.
- Crowds are capped at 9,999 agents (`AgentId` is `a` + up to 4 digits). A crowd above 100 agents plays each round in waves of 100 in a seeded order, each deciding from
  the market and the feed the wave before it left, so a round's `actions` are in the order they were executed, wave after wave.
- `report` text caps: `summary` ≤ 1,500 chars, `turningPoint.why` ≤ 800, `objections` and
  `priceDrivers` ≤ 5 items of ≤ 400 chars each.
- `sentimentByRound[i]` is the mean of the sentiments the agents reported in round `i+1`, each clamped
  to `[-1, 1]`, rounded to 4 decimals, `0` when no agent reported one.
- A post whose text is `[Removed by the copy guard.]` was flagged by the last read of the run's posts
  (`hyvo.report.review`) and removed before hashing; `report.flags` then holds `posts_removed:<n>`, and
  `post_review_incomplete` if that read could not finish.
- `report.flags` entries are also `rewritten:<rule>` (the copy guard had a phrase rewritten) or
  `redacted:<rule>` (a sentence was removed); `<rule>` names a rule in `engine/hyvo/report/guard.py`.

## Companion files (not part of the hash)

Stored next to `run.json` on the machine that played the run (`engine/.runs/<runId>/`); they are not published:

- `llm-log.jsonl` — every LLM request and raw response with token usage, one JSON object per line.
  Runs are replayable from this log, not re-runnable (LLM output is nondeterministic).
- `events.jsonl` — engine event log (round starts, validations, tx receipts).

## `question` (optional)

Only a run that was asked a question has this field. Without it the field is absent, not null, so older runs hash as they always did.

```jsonc
"question": {
  "text": "Will the token end its first week above its launch price?",
  "resolvesAt": "2026-12-01T00:00:00Z",      // the commit's resolvesAt
  "answers": { "yes": 30, "no": 15, "unsure": 5 },
  "byAgent": { "a01": "yes", "a02": "no" },  // one answer per agent of crowd.agents
  "expectation": "yes"                       // more yes than no, more no than yes, or "split"
}
```

Rules: `byAgent` holds exactly the crowd's agents, `answers` are the counts of `byAgent`, and `expectation` follows from `answers`. An agent's answer is a synthetic reaction like its posts, not a
forecast by Hyvo. A batch that could not be answered leaves its agents `unsure`, and `report.flags` then has `question_incomplete`.

