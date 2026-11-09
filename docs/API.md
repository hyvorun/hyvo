# Hyvo API

Cloudflare Worker (`apps/api`, Hono, D1, KV, Workers AI). This document is the contract between the API, the web app
(`apps/web`), the runner (`engine/hyvo/runner`) and third parties. Request and response shapes are zod schemas in
`packages/schema/src/api.ts` and `packages/schema/src/jobs.ts`; the API's tests parse its answers with them.

- Base URL: `https://api.hyvo.run` (the Worker's `*.workers.dev` address answers too). Local: `http://127.0.0.1:8787`
  (`pnpm --filter @hyvo/api dev`).
- All responses are JSON (`application/json; charset=utf-8`) unless stated. Errors:
  `{ "error": { "code": "<machine_code>", "message": "<human text>" } }` with a matching HTTP status. A `429` carries
  `Retry-After` (seconds).
- Times are RFC 3339 UTC strings with seconds precision. Run ids are `run_<ULID>`. Addresses are EIP-55 checksummed
  in responses. Token amounts are base units as decimal strings (`"1000000"` = 1 USDG, 6 decimals).
- Results are synthetic crowd reactions, not trading signals. Every response that carries run results also carries
  `"disclaimer": "Synthetic crowd reaction. Not a trading signal."`.
- Browser routes (`/v1/*`) answer CORS only for `WEB_ORIGIN`.

Contents: [Authentication](#authentication) · [Runs](#runs) · [Hyvo Check](#hyvo-check) · [Quotes and payments](#quotes-and-payments) ·
[Oracle](#oracle) · [Admin](#admin) · [Runner jobs](#runner-jobs) · [LLM endpoint](#llm-endpoint) ·
[Background work](#background-work) ·
[Money rules in the API](#money-rules-in-the-api) · [Verifying a run](#verifying-a-run) · [`RunSummary`](#runsummary)

---

## Authentication

The kinds of caller:

| Caller | How | Routes |
|---|---|---|
| Anyone | nothing | `GET /v1/health`, `/v1/runs*` reads, `/v1/artifacts/*`, `/v1/oracle*`, `GET /v1/check/:token`, the reading tools of `/mcp` |
| A wallet | `Authorization: Bearer <session token>` from Sign-In with Ethereum | `/v1/me`, `/v1/keys*`, `/v1/auth/logout`, and all of the next row; `/v1/admin/*` for founder wallets |
| A bot | `Authorization: Bearer hyvo_…`, an API key of that wallet | `/v1/quotes`, `/v1/orders*`, `POST /v1/runs`, `POST /v1/runs/:id/ask`, `/v1/balance*`, `/v1/webhooks*`, all of `/mcp` |
| The runner | `Authorization: Bearer <RUNNER_TOKEN>` | `/internal/*` except the LLM endpoint |
| The engine's LLM client | `Authorization: Bearer <LLM_TOKEN>` | `/internal/llm/*` and nothing else |

Signing in is a signature, never a transaction: it costs nothing and moves no funds.

### `POST /v1/auth/siwe/nonce`

`201 { "nonce": "<24 alphanumerics>", "expiresAt": "…" }`. Single use, valid 10 minutes. Rate limit: 30/min per IP.

### `POST /v1/auth/siwe/verify`

Body `{ "message": "<EIP-4361 message>", "signature": "0x…" }`. The message must have `domain` = `SIWE_DOMAIN`,
`uri` on `WEB_ORIGIN`, `chainId` = 4663, `version` 1, the nonce from above, no `expirationTime` in the past and no
`issuedAt` more than 5 minutes ahead. EOA signatures are checked locally; smart-wallet signatures (ERC-1271 /
ERC-6492) are checked against the chain. The nonce is spent only by a valid signature.

`201 { "token": "<session token>", "address": "0x…", "expiresAt": "…", "admin": false }` (sessions last 7 days;
only the token's SHA-256 is stored). `401 invalid_signature` names what failed. Rate limit: 30/min per IP.

### `POST /v1/auth/logout` (session)

Ends the session. `200 { "ok": true }`.

### `GET /v1/me` (session)

`200 { "address", "admin", "holder": HolderStatus }`. Rate limit: 30/min per wallet (it reads the chain).
`HolderStatus` (SPEC 8.3):

```jsonc
{
  "enabled": true,                // false while HYVO_TOKEN_ADDRESS is empty
  "eligible": true,               // HOLDER_MIN held now AND at the block of 24 h ago
  "minBalance": "1000",           // token units
  "balance": "5000", "balance24hAgo": "4800",   // null when the chain could not be read
  "freeRunsPerMonth": 2, "freeRunsLeft": 1,
  "discountBps": 2000,
  "freeRunMax": { "agents": 50, "rounds": 10 }
}
```

A balance that cannot be read (RPC down, state older than the node keeps) makes the wallet not eligible.

---

## Runs

### `GET /v1/health`

```jsonc
{
  "ok": true,
  "version": "0.3.0",
  "features": { "payments": false, "oracle": false, "holder": false },   // what this API has switched on
  "limits": {
    "minAgents": 10, "maxAgents": 2000, "minRounds": 3, "maxRounds": 30,
    "maxDecisions": 840   // the largest agents x rounds the daily spend cap lets a run start with
  }
}
```

### `GET /v1/runs?limit=20&cursor=<opaque>`

Listed published runs, newest first (`publishedAt` desc, then `runId` desc). `limit` 1..50 (default 20). Unlisted
runs are left out. They are not private: anyone with the run id can open them, and the id is public on-chain with
the run's hash.

`200 { "runs": RunSummary[], "nextCursor": string | null, "disclaimer": "…" }`

### `GET /v1/runs/featured`

The home hero's run: the most recently published listed run marked `featured`, else the most recently published
listed run. `200 { "run": RunSummary, "disclaimer": "…" }` or `404 not_found`.

### `GET /v1/runs/:runId`

Status and summary. `run` is the published summary (null until published); `job` is the queue state of a paid or
free run (null for runs published by hand); `oracle` is its on-chain commit (null until queued, or when the oracle
is off).

```jsonc
{
  "run": RunSummary | null,
  "job": {
    "status": "queued",            // queued | running | complete | failed
    "attempt": 1,                  // attempts started (a job is returned to the queue once)
    "progress": { "round": 4, "rounds": 10 } | null,   // while running
    "queuedAt": "…", "startedAt": "…" | null, "finishedAt": "…" | null,
    "refund": null                 // "due" | "sent" for a failed paid run
  } | null,
  "oracle": { "status": "confirmed", "txHash": "0x…", "blockNumber": 123, "chainId": 4663, "oracleAddress": "0x…" } | null,
  "disclaimer": "…"
}
```

`oracle.status`: `pending` (queued) → `sent` → `confirmed`; `failed` is retried with waits growing to one hour, for
as long as it takes, unless the chain already holds another hash for the run. `404 not_found` when neither a run nor
a job exists.

### `GET /v1/runs/:runId/artifact`

A short-lived signed URL for the exact `run.json` bytes: `200 { "url": "<absolute URL>", "expiresAt": "…" }`.

The URL points at `GET /v1/artifacts/:runId/run.json?exp=<unix seconds>&sig=<hex>`, where
`sig = hex(HMAC-SHA256(ARTIFACT_SIGNING_KEY, "<runId>\n<exp>"))`. That route streams the object from Workers KV with
`Cache-Control: public, max-age=31536000, immutable` (published runs never change), `403 bad_signature` or
`403 expired` otherwise, and `503 not_ready` with `Retry-After` for a run published moments ago: KV can take up to
a minute to reach other locations, and the web app asks again by itself.

### `POST /v1/runs` (session or API key)

Start a run. Nothing runs before its payment is confirmed, a balance is debited or a holder credit is used (money rule 1).

- `{ "balance": true, "scenario", "agents", "rounds", "mix"?, "listed"?, "requestId"? }`: a run paid from the wallet's prepaid
  balance (`201 { "runId", "job", "chargedUsd" }`). The job, the debit and its ledger line are one transaction, written only if the
  balance covers it: `402 insufficient_balance` otherwise, with nothing taken. `requestId` (8 to 64 of `A-Za-z0-9_-`) is yours to
  choose, per wallet: a retry with the same id answers `200` with the first run and pays nothing more. A run that fails for good
  goes back to the balance, and `job.refund` says `credited`. Rate limit: 10/min per wallet.

- `{ "orderId": "0x…" }`: the run of a paid order (`200 { "runId", "job" }`). A paid order is queued as soon as the
  payment is seen, so this call is idempotent and mostly used to find the run. `402 payment_required` while unpaid
  (the message says when the quote expired). Another wallet's order answers `404`.
- `{ "credit": true, "scenario", "agents", "rounds", "mix"?, "listed"? }`: a holder free run (`201 { "runId", "job" }`).
  `403 not_eligible`, `403 no_credits`, `400` above `FREE_RUN_MAX_AGENTS` × `FREE_RUN_MAX_ROUNDS`,
  `503 holder_disabled`. Rate limit: 10/min per wallet.

---

### `POST /v1/runs/:runId/ask` (session or API key)

A follow-up question to one agent of a published run, or to its report. `{ "agentId": "a07" | "report", "question": "…" }`, up to 500
characters. Paid per call from the balance (`ASK_PRICE_USD`, default $0.01): `402 insufficient_balance` otherwise. Rate limit: 20/min
per wallet.

```jsonc
{
  "runId": "run_…",
  "agentId": "a07",
  "handle": "…",                  // null for the report
  "answer": "…",
  "withheld": false,              // true: it broke the copy rules, so it was not sent and not charged
  "chargedUsd": 0.01,
  "disclaimer": "Synthetic crowd reaction. Not a trading signal."
}
```

The only context is the run's own record, so an agent speaks from what it saw and did. The question is quoted as untrusted data. A
model that fails gives the money back: `429 llm_quota` with `Retry-After` when the free Workers AI allowance is used up, else
`502 llm_failed`. `404` for a run or an agent that does not exist.

---

## API keys and balances

### `POST /v1/keys` (session)

`{ "label"? }` → `201 { "key": "hyvo_…", "apiKey": { "id", "label", "prefix", "createdAt", "lastUsedAt" } }`. The key is shown this
once, and only its SHA-256 is stored. It spends the wallet's balance, and it can do what the wallet can except manage keys, so a key
that leaks cannot make more of itself. 10 active keys per wallet. A key is limited to 120 requests a minute.

### `GET /v1/keys`, `DELETE /v1/keys/:id` (session)

The wallet's active keys without the keys themselves, and revoking one. Another wallet's key answers `404`.

### `GET /v1/balance`

`{ "address", "balanceUsd", "entries": [{ "id", "deltaUsd", "reason", "runId", "createdAt" }] }`, the last 50 lines, newest first. `reason`
is `topup`, `run`, `run_failed`, `ask` or `ask_returned`. A balance is prepaid credit: an accounting entry in D1, with the funds in the
treasury (SPEC 8.5). It earns nothing.

### `POST /v1/balance/topups`

`{ "amountUsd": 5 }`, from `TOPUP_MIN_USD` to `TOPUP_MAX_USD`, at most two decimals → `201 { "topUp": { "orderId", "status", "address", "token",
"amount", "amountUsd", "creditedUsd", "createdAt", "expiresAt", "paidAt", "chainId", "paymentRouter" } }`. Pay it like an order: approve `amount` to
`paymentRouter`, then call `pay(orderId, token, amount)`. `503 payments_disabled` while payments are off.

A top-up credits the wallet that asked, whoever pays, and credits what arrived, even if it is late or a different amount: no price can
have changed. Only another token cannot be credited, and gets a refund record.

### `GET /v1/balance/topups/:orderId`, `POST /v1/balance/topups/:orderId/payment`

Its status, and `{ "txHash" }` to have a payment checked now instead of waiting for the cron: `{ "topUp", "check", "message" }`, with `check` as for
orders. Another wallet's top-up answers `404`.

---

## Webhooks

### `POST /v1/webhooks`

`{ "url": "https://…", "events": ["run.completed"] }` → `201 { "webhook": { "id", "url", "events", "createdAt", "disabledAt", "failedInARow" },
"secret": "whsec_…" }`. The secret is shown once. 5 per wallet. The URL must be https, on a public host: no address, `localhost`, `.local` or
`.internal`, and no user or password in it.

| Event | Goes to | `data` |
|---|---|---|
| `run.completed` | the wallet that started the run | `runId`, `hash`, `title`, `status` |
| `run.failed` | the wallet that started the run, when it failed for good | `runId`, `reason`, `refund` |
| `run.published` | every webhook that asked, when the run is listed; else its own wallet's | `runId`, `hash`, `title`, `status` |
| `oracle.committed` | every webhook that asked, when the run is listed; else its own wallet's | `runId`, `hash`, `txHash`, `blockNumber` |

### A delivery

`POST` to your URL, with `Content-Type: application/json`, `X-Hyvo-Event`, `X-Hyvo-Delivery` and `X-Hyvo-Signature`:

```jsonc
{
  "id": "evt_…",                  // the same in a repeat: use it to drop one
  "type": "run.completed",
  "createdAt": "2026-11-06T10:00:00Z",
  "data": { "runId": "run_…", "hash": "0x…", "title": "…", "status": "complete" },
  "disclaimer": "Synthetic crowd reaction. Not a trading signal."
}
```

`X-Hyvo-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>` under the secret. `verifyWebhook` in
`packages/sdk` checks it and refuses a signature more than 5 minutes off. Any 2xx counts as delivered. A redirect does not, and is not
followed. Anything else is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then given up. A webhook whose last
20 deliveries were all given up on is switched off (`disabledAt`). The cron sends at most 5 deliveries a minute.

### `GET /v1/webhooks`, `DELETE /v1/webhooks/:id`, `GET /v1/webhooks/:id/deliveries`

The wallet's webhooks, deleting one, and its last 20 deliveries (`status`, `attempts`, `nextAttemptAt`, `lastError`), for finding out why a receiver
hears nothing. Another wallet's webhook answers `404`.

---

## MCP

`POST /mcp`: a remote MCP server (SPEC 8.5) over Streamable HTTP, protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`. It is stateless: each
POST holds one JSON-RPC message and gets one JSON answer, there are no sessions, and `GET` answers `405`, which the transport allows. A request with
an `Origin` other than the web app's answers `403`. An API key goes in `Authorization: Bearer hyvo_…`; a bad one answers `401`. Without a key, calls
are limited to 120 a minute per IP.

| Tool | Key | What it does |
|---|---|---|
| `create_run(scenario, size, rounds, listed?, requestId?)` | yes | Starts a run from the balance: `{ "status": "started", "runId", "job", "chargedUsd" }`. If the balance is short and payments are open: `{ "status": "payment_required", "order", "howToPay" }`, a real order. |
| `get_run(runId)` | no | The same answer as `GET /v1/runs/:runId`. |
| `ask_agent(runId, agentId, question)` | yes | The same answer as `POST /v1/runs/:runId/ask`. |
| `list_recent_runs(filter?, limit?)` | no | Listed runs, newest first. `filter`: `titleContains`, `status`. At most 20. |
| `verify_run(runId)` | no | `hash`, `commit`, `onChain`, `matches`, `chainId`, `oracleAddress`, a signed `artifact` link and `howToVerify`. It reads the chain, but the proof is yours to recompute (below): `verifyRun` in `packages/sdk` does it. |
| `check_token(address)` | no | The same answer as [`GET /v1/check/:token`](#get-v1checktoken), from the same cache and under the same limit of 10 checks a minute per IP: a token's facts at one block with their evidence, and `disclaimer`. Facts, not a verdict about the token. |

A tool's failure is an answer with `isError: true` and a message a model can act on, not a protocol error. Every tool's answer is in `structuredContent`,
and as JSON text in `content`.

---

## Dry Runs

A crowd of synthetic users tries a contract before mainnet (SPEC 11.1): newcomers, power users, an adversary and a whale call what its ABI
offers. A report is the wallet's own, because it may describe a bug in something not yet live: it never reaches the gallery, nothing about it goes
on-chain, and `GET /v1/runs/:runId` answers `404`. A Dry Run is not an audit: it finds what its synthetic users happened to run into.

All of these take a session or an API key. Another wallet's Dry Run answers `404`. In `packages/sdk`: `createDryRun`, `listDryRuns`, `getDryRun`,
`waitForDryRun` and `fetchDryRunReport`, which refuses a file that does not match its hash.

### `POST /v1/dryruns`

The price, set by the crowd's size like a run's, comes out of the balance in the same step that queues it.

```jsonc
{
  "balance": true,
  "requestId": "my-bot-0001",        // optional: a retry returns the first Dry Run and pays nothing more
  "description": "A savings vault.", // what it does, in plain language; at most 2,000 characters
  "address": "0x…",                  // a contract on Robinhood Chain, played on a fork; its ABI comes from Sourcify unless given
  "bytecode": "0x…",                 // or creation code of at most 49,152 bytes, played on a plain chain; it needs `abi`
  "abi": [ … ],
  "constructorArgs": [ … ],          // with `bytecode`
  "invariants": ["isSolvent"],       // at most 10 view functions without arguments that must stay true
  "agents": 12,                      // 4 to 40, default 12
  "rounds": 8                        // 1 to 30, default 8
}
```

Give exactly one of `address` and `bytecode`. `201 { "dryRun": DryRunView, "disclaimer" }`, or `200` for a `requestId` already seen.
`402 insufficient_balance`, `413 too_large` (a body over 256 KB), `429` past 5 a minute per wallet.

### `GET /v1/dryruns`, `GET /v1/dryruns/:runId`

The wallet's 20 latest, or one, as `DryRunView` (`packages/schema/src/dryrun.ts`):

```jsonc
{
  "runId": "run_…",
  "title": "A savings vault.",
  "status": "queued | running | complete | failed",
  "progress": { "round": 3, "rounds": 8 } | null,
  "queuedAt": "2026-11-06T00:00:00Z",
  "finishedAt": "2026-11-06T00:02:00Z" | null,
  "chargedUsd": 1,
  "hash": "0x…" | null,              // of the report
  "summary": { "status": "complete", "findings": { "high": 7, "medium": 0, "low": 2, "info": 0 }, "calls": 96, "reverted": 3 } | null,
  "failReason": "…" | null,          // why it failed; what it cost has gone back to the balance
  "refund": "credited" | null
}
```

### `GET /v1/dryruns/:runId/report`

The exact `dryrun.json`. `409 not_ready` until it is complete, and `503` with `Retry-After` for the moment after delivery. It is hashed like a run
([below](#verifying-a-run)), but the hash stays off-chain. The format is `DryRunReport` in `packages/schema/src/dryrun.ts`:

- `findings`: `severity`, `kind`, `title`, `detail`, and `reproduce`, the calls that lead to it, in order;
- `invariants`: whether each one held, and the call where it first broke;
- `calls`: every call with its result, gas and what changed. An invalid call is recorded, not sent;
- `probes`: what a stranger's wallet got from the functions kept out of the crowd's hands;
- `feedback`, `finalState`, `actionSpace`, `crowd`, `usage`.

---

## Wallet Clone

One agent of a crowd trades by a wallet's recorded numbers (SPEC 11.3). Only the wallet that signed in can have a clone: every call needs a **session**, never an API key, and no call takes an address.
`features.clone` in `/v1/health` says whether clones are open.

### `POST /v1/clones/me` (session)

Starts reading this wallet's trades on Robinhood Chain. `201 { "clone": CloneView, "open", "disclaimer" }`, or `200` when a build is already running. `503 clones_closed`, `429` past 3 builds an hour. It is free.

### `GET /v1/clones/me` (session)

`{ "clone": CloneView | null, "open": true, "disclaimer" }`:

```jsonc
{
  "status": "building | ready | failed",
  "failReason": "this wallet has 2 trades on Robinhood Chain, and a clone needs at least 5" | null,
  "updatedAt": "2026-11-06T00:00:00Z",
  "profile": {                // numbers only: no address, no token, no date. null until it is built
    "version": 1, "trades": 40, "buys": 25, "sells": 15, "tokens": 9,
    "typicalBuyEth": 0.12, "smallBuyEth": 0.05, "largeBuyEth": 0.3,
    "medianHoldHours": 3.5,   // from buying a token to first selling it
    "soldWithinHourPct": 40, "stillHeldPct": 20, "medianSellPct": 100,
    "medianEntryMinutes": 12, // the token's age when the wallet first bought it
    "earlyEntryPct": 70
  } | null
}
```

### `DELETE /v1/clones/me` (session)

`204`. Removes the numbers, the jobs that built them, and the copy in any run ordered with them. A published run keeps what its agent did, under its generated handle, and never held these numbers.

### Running it

`POST /v1/runs` with `{ "balance": true, "clone": true, "scenario", "agents", "rounds" }` puts one agent in the crowd, with `persona: "clone"` in run.json. `409 no_clone` until a clone is ready. Such a run never reaches
the gallery, and it takes the default crowd: `mix` and `listed: true` answer `400`.

---

## Rewind

`POST /v1/runs` with `rewind` plays a past moment of a real pool again with one thing changed (SPEC 11.4):

```jsonc
{
  "balance": true,
  "rewind": { "pool": "0x…", "block": 106913859, "hours": 6 },     // hours: 1 to 72, how far ahead to compare
  "scenario": { "title": "…", "seedText": "…", "events": [{ "round": 3, "text": "The rumor came two hours earlier." }] },  // exactly one event: the change
  "agents": 50, "rounds": 10
}
```

The runner forks the chain at the block, seeds a test pair with the reserves the pool had there, and writes `rewind` into run.json before the first round: the pool, the block and its time, the change, and in `actual` the pool's
reserves and price at evenly spaced blocks. Anyone can read those from the chain with `getReserves()`. The run stays out of the gallery, because it names a real token (`docs/OPEN_ITEMS.md` item 23): `listed: true` answers `400`, as
does a `market` with liquidity. A pool must have a contract address with `getReserves()`, and be priced in ETH. A block the node has no state for, or a window that reaches past the newest block, fails the job, and the price
goes back to the balance.

---

## Hyvo Check

Facts about a token on Robinhood Chain, read at one block, each with its evidence: verified source, owner, proxy, owner-style functions, where it
trades, and an exit simulation that buys the token, sends a tenth of it to a fresh address and sells the rest, inside one read-only `eth_call`
(`packages/check/README.md`). Its top holders, and its creator when no launch record or Sourcify names one, come from Blockscout's index, read with
the API's own key ([`GET /v1/check/:token/holders`](#get-v1checktokenholders)). Nothing is signed, approved or sent. A report is not a verdict
about the token, not an audit and not a trading signal. MCP's `check_token` gives the same answer.

### `GET /v1/check/:token`

No key and no session. `:token` is the token's address: `0x` and 40 hex characters, in any letter case.

`200`: the report of `@hyvo/check` (`checkToken` with its defaults, written by `serializeReport`, so amounts and the block are decimal strings),
then three fields of this API. The type is `CheckResponse` in `apps/api/src/lib/check.ts`.

```jsonc
{
  "chainId": 4663,
  "token": { "address": "0x…", "name": "…" | null, "symbol": "…" | null, "decimals": 18 | null, "totalSupply": "…" | null },
  "block": "109871808",            // every read and the simulation ran here, two blocks below the head
  "findings": [                    // always 11, in this order: source, owner, proxy, mint, fee-setter, blocklist, pause,
                                   // venue, sell-simulation, holders, deployer
    { "id": "venue", "title": "Trading venue", "status": "found", "evidence": "the Uniswap V2 pair 0x… with WETH, holding … WETH and … tokens" },
    …
  ],
  "exit": {                        // null when there is no venue the simulation covers; the sell-simulation finding says why
    "venue": { "kind": "v2", "router": "0x…", "pair": "0x…" },       // or pons-curve, pons-v4, v3
    "ethIn": "1000000000000000",   // 0.001 ETH
    "payout": "eth",               // or weth
    "buy": { "ok": true, "promised": "…", "arrived": "…", "shortfallPct": 0, "gas": "133547", "reason": null },
    "transfer": { … } | null,      // a tenth of what arrived, sent to a fresh address
    "sell": { … } | null,
    "roundTrip": { "spent": "…", "back": "…", "lossPct": 0.59 } | null
  } | null,
  "code": { "bytes": 2560, "proxyImplementation": "0x…" | null, "owner": "0x…" | null, "ownerRenounced": false, "sourcify": "none" },
  "timings": { "totalMs": 1370, "chainMs": 900, "simulationMs": 350, "sourcesMs": 400, "requests": { "rpc": 8, "sourcify": 1, "blockscout": 0 } },
                                   // the check's own requests; Blockscout's three for the holders are read apart and not counted here
  "notice": "Facts read from Robinhood Chain at one block, each with its evidence. Not a trading signal, and not an audit.",
  "checkedAt": "2026-11-09T07:12:00Z",                               // when the check ran
  "skippedByApi": [],              // without BLOCKSCOUT_API_KEY: [{ "id": "holders", "reason": "Top holders come from Blockscout, …" }]
  "disclaimer": "Measured on-chain at block 109871808. Not a trading signal."
}
```

With the key, the `holders` finding reads, for example: "the 2 largest holders hold 30% of the supply, leaving out burn addresses, the Uniswap V4
PoolManager, the Uniswap V2 pair; 3 holders in all (Blockscout); the deployer 0xAbc9…0f21 holds 10%; balances from Blockscout's index, read through
Hyvo's API at 07:12 UTC on 2026-11-09, not read at block 109,871,808". The share is of the supply read at the block, of the balances in the index.

A finding's `status` is `found` (the check found what it looks for), `not_found` (it looked, and the evidence says where) or `skipped` (it could
not look, and the evidence says why). `CHECKS[id].looksFor` in `@hyvo/check`, and its README, say what each check looks for. A step's
`shortfallPct` compares what arrived with what the venue's own math promised after its published fees and taxes.

- **Top holders and Blockscout.** With the Worker secret `BLOCKSCOUT_API_KEY` set, a check reads the token's holders and creator from
  Blockscout's index beside the chain reads, through the same cache as the holders route below: the `holders` finding gives the ten largest
  holders' share of the supply with burn addresses, the Uniswap V4 PoolManager and the token's pools left out, and the `deployer` finding falls
  back to Blockscout's creator after the Pons factories' records and Sourcify. Both name Blockscout's index as their source, with the time it
  was read; it is not read at `block`. When Blockscout answers `429`, fails, takes more than 5 s or lists no holder, the finding is `skipped`
  and its evidence says why. Without the key, `holders` is `skipped`, `skippedByApi` says why, and Blockscout is never asked. Verified source comes from
  Sourcify alone either way. The simulation always buys with 0.001 ETH.
- **Cache.** One check per token per UTC minute, about 600 blocks: every request in the minute gets the first one's answer, with
  `X-Hyvo-Cache: hit` and `Cache-Control: public, max-age=<seconds left in the minute>`. `block` and `checkedAt` say when it was read. The Cache
  API keeps an answer in the Cloudflare data center that made it, and Cloudflare documents it as working for Workers on custom domains such as
  `api.hyvo.run` (read 2026-11-09); where it does not hold answers, every request is a new check. Errors are never cached, so an address
  without a token is asked again next time.
- **Errors.** `400 bad_request` for anything that is not an address. `404 not_a_contract` (no code at the block) and `404 not_a_token` (neither
  `totalSupply()` nor `balanceOf(address)` answers). `503 chain_unavailable` with `Retry-After` when Robinhood Chain cannot be read. `504
  check_timeout` after 25 s. `503 check_disabled` without `RPC_URLS`, or with a `CHAIN_ID` other than 4663.
- **Rate limit:** 10 checks a minute per IP, shared with `check_token`. An answer from the cache does not count.
- **Inside the Workers Free plan** (50 subrequests and 10 ms of CPU a request, item 21). A check makes at most 11 JSON-RPC calls, and the
  client tries each one on every URL twice, so a check uses the first two URLs of `RPC_URLS`: at most 44 requests, plus 1 or 2 to Sourcify,
  plus 3 to Blockscout when the token's holders are not in the cache: at most 49. A test holds the Worker to that worst case.
  Measured on 2026-11-09 against dRPC, with the Worker's own bundle in local workerd, for tokens on a Uniswap V2 pair, a Pons curve and a Pons
  V4 pool, USDG (a proxy) and a token on a V4 pool outside Pons: 7 to 10 JSON-RPC requests and 1 or 2 Sourcify requests, 1 to 3.2 s, and an
  answer from the cache in 8 to 20 ms. CPU, measured in Node 24 on recorded answers: 2 to 4 ms a check once the code is warm, more for the
  first check in a fresh isolate. Blockscout's answers are parsed for the few fields below and nothing else is kept; their CPU cost with the
  real key is not measured yet (`docs/OPEN_ITEMS.md` item 30).

### `GET /v1/check/:token/holders`

No key and no session; CORS as every `/v1/*` route. A token's top holders and creator from Blockscout's index, read by this API with its own
key, which never leaves the Worker: no answer, header, error or log carries it. The /check page asks this route while the browser reads the
chain, and the check in the browser leaves out burn addresses and pools as it does everywhere. The type is `HoldersResponse` in
`apps/api/src/lib/holders.ts`; `parseHolderFacts` in `@hyvo/check` reads it back.

```jsonc
{
  "token": "0x…",                                   // checksummed
  "source": "Blockscout's index, read through Hyvo's API at 07:12 UTC on 2026-11-09",   // what the evidence names
  "totalSupply": "…" | null,                        // Blockscout's; a check prefers the supply it reads at its block
  "holderCount": 1234 | null,
  "holders": [{ "address": "0x…", "value": "…" }, …] | null,   // Blockscout's first page, largest first, at most 50, nothing left out
  "holdersMissing": null | "Blockscout's API answered 429 for the token's holders: its free tier allows 5 requests a second",
  "creator": { "address": "0x…", "creationTxHash": "0x…" | null } | null,
  "creatorMissing": null | "Blockscout's index names no creator for the token",
  "readAt": "2026-11-09T07:12:00Z",                 // when this API read Blockscout
  "disclaimer": "Read from Blockscout's index through Hyvo's API at 2026-11-09T07:12:00Z, not at one block. Not a trading signal."
}
```

- **Where it comes from.** Three requests to `https://api.blockscout.com/4663/api/v2`, made at once and each tried once: `tokens/<address>`
  (total supply and holder count), `tokens/<address>/holders` (the first page) and `addresses/<address>` (`creator_address_hash` and
  `creation_transaction_hash`). Only those fields are kept, each checked: addresses, decimal digits, a 32-byte hash. A part Blockscout did not
  answer is `null`, and `holdersMissing` or `creatorMissing` says why in plain words. A page that lists no holder is `null` too, with
  "Blockscout's index lists no holders for the token yet", never an empty list that a share of 0% could be read from.
- **Cache.** Per token for the rest of a ten-minute UTC window, in the Cache API, shared with the checks above: `X-Hyvo-Cache: hit` and
  `Cache-Control: public, max-age=<seconds left in the window>`. Facts with a part Blockscout did not answer (a `429`, a timeout, a `5xx`), or
  with a page that lists no holder, are not kept and carry `Cache-Control: no-store`, so the next request asks again.
- **Limits.** 10 reads a minute per IP on this route (an answer from the cache does not count), then `429 rate_limited` with `Retry-After`. The
  Worker as a whole starts at most 60 reads a minute, 3 requests each, under Blockscout's free tier of 5 requests a second; past that the
  facts say so (`holdersMissing`, `creatorMissing`) and Blockscout is not asked. Blockscout's free tier also allows 100,000 credits a day; what
  one request costs in credits is not known yet (item 30).
- **Errors.** `400 bad_request` for anything that is not an address. `503 holders_disabled` when the Worker has no `BLOCKSCOUT_API_KEY`.

---

## Quotes and payments

### `POST /v1/quotes` (session)

```jsonc
{
  "scenario": {
    "title": "Fictional token FIZZ lists with a 3% creator tax",   // 1-200 characters, a letter or digit
    "seedText": "…",                                               // 0-4,000 characters (code points)
    "events": [{ "round": 3, "text": "A large wallet enters." }],  // ≤ 50, ≤ 5 per round, text ≤ 500
    // Optional. Amounts are decimal strings from 0.001; events need visible text.
    "market": { "tokenSymbol": "FIZZ", "tokenName": "…", "liquidityEth": "5", "liquidityTokens": "100000000", "feeBps": 300 }
  },
  "agents": 50,               // MIN_AGENTS..MAX_AGENTS (10..2000); agents x rounds at most MAX_RUN_DECISIONS (15000), which keeps a run's file under its 5 MB limit
  "rounds": 10,               // MIN_ROUNDS..MAX_ROUNDS (3..30); events must fall within the rounds
  "mix": { "sniper": 10, "holder": 15, "panic_seller": 10, "skeptic": 15 },   // optional, sums to agents; also swing_trader, whale, kol_follower, market_maker_bot, stock_token_holder, newcomer
  "listed": true              // optional; false keeps the run out of the gallery
}
```

The text limits are the engine's own (`engine/hyvo/scenarios`), so an accepted quote is a job the runner can play;
the engine sanitizes the text again (URLs become plain text, control characters go).

`201 { "order": Order }`:

```jsonc
{
  "orderId": "0x…",                       // bytes32 for PaymentRouter.pay
  "status": "quoted",                     // quoted | paid | expired
  "address": "0x…",                       // the signed-in wallet
  "token": { "address": "0x…", "symbol": "USDG", "decimals": 6 },
  "amount": "1000000",
  "priceUsd": 1, "estimatedCostUsd": 0.17, "discountBps": 0,
  "createdAt": "…", "expiresAt": "…",     // QUOTE_TTL_S (30 min)
  "paidAt": null, "runId": null,
  "chainId": 4663, "paymentRouter": "0x…",
  "run": { "title": "…", "agents": 50, "rounds": 10, "listed": true }
}
```

`503 payments_disabled` until `RPC_URLS`, `PAYMENT_ROUTER_ADDRESS` and `USDG_ADDRESS` are set. `400 over_daily_cap`
when the run's budget alone passes `DAILY_SPEND_CAP_USD`: paid, it could never start. Rate limits: 20/min per wallet,
60/min per IP. See [pricing](#pricing).

### Paying

The wallet approves exactly `amount` of `token` for `paymentRouter`, then calls
`PaymentRouter.pay(orderId, token, amount)`. The router moves the tokens from the payer to the treasury in the same
call and emits `Paid(orderId, payer, token, amount, timestamp)`; it holds nothing and accepts an `orderId` once.
Hyvo never holds, approves or moves anyone's tokens.

### `GET /v1/orders` and `GET /v1/orders/:orderId` (session)

The wallet's 20 latest orders, or one order: `200 { "orders": Order[] }`, `200 { "order": Order }`. Another
wallet's order answers `404`.

### `POST /v1/orders/:orderId/payment` (session)

Check a payment now instead of waiting for the per-minute scan. Body `{ "txHash": "0x…" }`.
`200 { "order": Order, "check": "<result>", "message": "…" }`:

| `check` | Meaning |
|---|---|
| `paid` | the order is paid and its run queued (`order.runId`) |
| `pending` | the transaction has fewer than `PAYMENT_CONFIRMATIONS` blocks on top; ask again |
| `not_found` | the chain does not know the transaction yet |
| `failed` | the transaction reverted; nothing was paid |
| `no_payment` | no `Paid` event of the router for this order in the transaction |
| `mismatch` | it paid this order but cannot pay for it (see [matching](#payment-matching)); a refund is due |

`503 chain_unavailable` when the chain cannot be read right now; ask again. Rate limit: 30/min per wallet.

---

## Oracle

### `GET /v1/oracle?cursor=<opaque>`

The commit ledger, newest first, 25 per page:
`200 { "chainId", "oracleAddress": "0x…" | null, "entries": OracleEntry[], "nextCursor", "disclaimer" }`.

```jsonc
{
  "runId": "run_…", "runIdBytes32": "0x…",
  "reportHash": "0x…",          // the run hash
  "scenarioHash": "0x…",
  "title": "…" | null,          // null for unlisted runs
  "status": "confirmed",        // pending | sent | confirmed | failed
  "txHash": "0x…" | null, "blockNumber": 123 | null, "committedAt": "…" | null
}
```

### `GET /v1/oracle/:runId`

`200 { "entry": OracleEntry, "chainId", "oracleAddress", "onChain": OnChainCommit | null, "matches": boolean | null,
"disclaimer" }`. `onChain` is `HyvoOracle.getCommit` as the API read it (`null` when not committed or the chain could
not be read); `matches` compares it with the API's record. Do not trust it: [verify it yourself](#verifying-a-run).
`404` when the run has no commit. Rate limit: 60/min per IP (it reads the chain).

---

## Calibration

### `GET /v1/calibration`

How often the crowd's lean matched what happened, misses as plainly as hits (SPEC 11.2). `{ "counts": { "hits", "misses", "noLean", "void", "open" }, "hitRate", "buckets", "resolved",
"open", "disclaimer" }`. `hitRate` is hits / (hits + misses), and null before there is one of either. A split crowd (`no_lean`) and a void question stay out of the rate and on the list.
`buckets` sorts hits and misses by how firm the lean was: the larger side's share of yes + no. Unlisted runs are not counted.

### Asking

`POST /v1/quotes`, `POST /v1/runs` and MCP's `create_run` take `question: { "text", "resolvesAt" }`: a neutral yes or no question of 10 to 300 characters, and a date from
`QUESTION_MIN_DELAY_S` (one hour) to `QUESTION_MAX_DELAY_S` (a year) away. A question that breaks the copy rules answers `400`. At the end of the run every agent answers yes, no or unsure,
and `run.question` holds the answers (docs/RUN_FORMAT.md). The commit carries the date as its `resolvesAt`. `RunSummary.question` and `/v1/calibration` show the lean right away.

### `POST /v1/admin/questions/:runId/resolve` (founder wallets)

`{ "outcome": "yes" | "no" | "void", "note": "how you know", "evidenceUrl"? }` → `{ "runId", "outcome", "outcomeHash" }`. `409 too_early` before the date, `409 already_resolved` after the first
call. The outcome document is fixed here, and the Worker sends `HyvoOracle.resolve(runId, keccak256(document), "<api>/v1/runs/<id>/outcome")` with the attester key, then or from the cron,
with growing waits after a failure. It waits for the run's commit to land, and it stops if the chain holds another outcome.

### `GET /v1/runs/:runId/outcome`

The outcome document: the exact bytes whose keccak-256 is on-chain, as canonical JSON (`runId`, `question`, `resolvesAt`, `expectation`, `outcome`, `note`, `evidenceUrl`, `decidedAt`). `GET
/v1/runs/:runId` also shows it as `outcome`. Webhook event `question.resolved` fires once it is on-chain, with `outcome` and `result`.

---

## Admin

Founder wallets only (`ADMIN_ADDRESSES`); a session of another wallet gets `403 forbidden`.

### `GET /v1/admin/overview`

`200` with `features` (payments, oracle, holder), `queue` (paused, queued, running, `spendTodayUsd`, `dailyCapUsd`),
`fees` (USDG received today and in 30 days, payments in 30 days), `jobs` (complete, partial and failed in 7 days),
the 20 latest `failures` (with reasons and refund state), `refunds` (all due, then those sent in 30 days; `symbol`
and `decimals` are null for a token the API does not know, whose `amount` then only means base units) and `oracle`
(pending, failed, the last error). Shape: `AdminOverviewResponse` in `packages/schema/src/api.ts`.

### `POST /v1/admin/refunds/:id`

Record a refund sent by hand from the treasury: `{ "txHash": "0x…", "note"?: "…" }` → `200 { "refund" }`;
`404` when no refund with this id is due. See `docs/RUNBOOK.md`, "Refunds".

### `POST /v1/admin/queue`

`{ "paused": true }` stops handing out jobs (running jobs finish); `{ "paused": false }` resumes.

---

## Runner jobs

`Authorization: Bearer <RUNNER_TOKEN>` on every call except the signed upload. The API is the source of truth; the
runner can disappear at any time (SPEC 3). Reference client: `engine/hyvo/runner/api.py`.

### `GET /internal/jobs/next`

Claims the next queued job (holder runs first, then oldest). First returns jobs whose runner went quiet to the
queue (see below).

- `204` with `X-Hyvo-Queue: empty | paused | spend_cap` when there is nothing to hand out. `spend_cap`: the next
  job's budget would take today's LLM spend past `DAILY_SPEND_CAP_USD` (UTC day).
- `200 { "job": RunnerJob }`:

```jsonc
{
  "runId": "run_…",                 // the run must carry this id
  "leaseId": "lease_…",             // proves this attempt; required on every later call
  "attempt": 1,                     // 1 or 2
  "heartbeatIntervalS": 15,
  "timeoutS": 1800,
  "spec": {
    "version": 1,
    "scenario": { "title": "…", "seedText": "…", "events": [{ "round": 3, "text": "…" }], "market": { … } | null },
    "agents": 50, "rounds": 10,
    "mix": { "sniper": 10, … } | null,
    "batchSize": 10,
    "maxCostUsd": 0.34, "maxLlmCalls": 106,
    "seed": null
  }
}
```

The runner refuses a spec it cannot read (unknown member, wrong type, value out of range) and reports it with `fail`.

A Dry Run's job adds `"kind": "dryrun"`, and its `spec` is the submission with `maxCostUsd` and `maxLlmCalls`. Its upload is `dryrun.json`, and its
`complete` takes `{ "leaseId", "hash", "sha256", "summary", "usage" }` (`DryRunMeta`). Nothing is published or committed.

A clone's job adds `"kind": "clone"`, and its `spec` is `{ "address" }`, the wallet that signed in. It uploads nothing: `complete` takes `{ "leaseId", "profile" }`, and the runner then deletes its folder for that job. A run's `spec` can carry
`clone` (the numbers) and `rewind` (`{ "pool", "block", "hours" }`).

### `POST /internal/jobs/:runId/heartbeat`

`{ "leaseId", "progress"?: { "round", "rounds" } }` every `heartbeatIntervalS`. `200 { "ok": true }`;
`409 lease_lost` when the job went back to the queue or ended, so the runner must stop and drop the run;
`404` for an unknown job.

### `POST /internal/jobs/:runId/upload-url`

`{ "leaseId" }` → `200 { "url", "method": "PUT", "headers", "expiresAt", "maxBytes": 5242880 }`. The URL is
`/uploads/:runId?lease=<leaseId>&exp=<unix>&sig=<hex>` with
`sig = hex(HMAC-SHA256(ARTIFACT_SIGNING_KEY, "upload\n<runId>\n<leaseId>\n<exp>"))`, valid 15 minutes and only for that
attempt.

### `PUT /uploads/:runId?lease&exp&sig`

The run.json bytes (≤ 5 MB), no runner token: the signature authorizes it. Stored in KV at
`runs/<runId>/<leaseId>.json`, with its SHA-256 and size in D1. `200 { "size", "sha256" }`;
`400 invalid_run` when the bytes do not start like a JSON object; `403 bad_signature | expired` (ask for a new URL);
`409 lease_lost`; `413 too_large`.

### `POST /internal/jobs/:runId/complete`

`RunMeta` plus the lease (`packages/schema/src/api.ts`):
`{ "leaseId", "hash", "scenarioHash", "sha256", "summary", "usage": { "costUsd", "llmCalls" }, "eventRounds" }`. The
runner computes it from the run after verifying that run locally (`engine/hyvo/runfile/summary.py`; Python and
TypeScript are held to the same test vectors).

**The Worker does not parse or re-hash the run.** The Workers Free plan gives it 10 ms of CPU per request, which is
not enough (`docs/OPEN_ITEMS.md` item 21). It checks that `sha256` is the upload's, and that the metadata is the
job: its `runId`, the crowd size, no more rounds than ordered (all of them for a `complete` run), the events' rounds,
the token symbol and the persona mix when the order sets them. Text is not compared, because the engine sanitizes
it. Every browser that opens the run re-hashes the bytes, and [anyone can](#verifying-a-run). With
`VERIFY_RUNS_IN_WORKER=1` (Workers Paid) the upload also runs the zod schema and recomputes the hash, and the `hash`
sent must equal it.

Then, in one D1 transaction and only if this runner still holds the job, it ends the job, publishes the upload (D1
row with the order's `listed`; the bytes stay at their KV key), replaces the attempt's spend reservation with
`usage.costUsd` and queues the oracle commit, which it then sends right away.

A run over its budget is published and logged (`job_over_budget`), not refused. The engine's budget check works on
estimates, so a run can end one call over budget (`hyvo/llm/budget.py`). That money is spent and the run is what was
paid for; refusing it would only play and pay for it again.

`200 { "runId", "hash", "publishedAt" }`. Repeating the call with the same lease and hash answers `200` again (a lost
response can be retried). `422 missing_upload | run_mismatch`, `409 lease_lost | conflict` (same `runId`, another
hash).

### `POST /internal/jobs/:runId/fail`

`{ "leaseId", "reason" (kept to 500 characters; no secrets or user text), "retryable": true }` → `200 { "status" }`:
`queued` when the job goes back to the queue (first attempt and `retryable`), else `failed`.

### Lost runners and timeouts

A running job whose last heartbeat is older than `HEARTBEAT_TIMEOUT_S` (90 s), or which runs past
`timeoutS` + 300 s, is treated as a failed attempt: back to the queue once, then `failed`. The runner itself kills
its run at `timeoutS` and reports `fail`; it gives the engine `timeoutS` − 120 s, so a slow run normally ends as a
`partial` run.json rather than a failure.

A job that fails for good is settled in the same D1 transaction: a paid job gets a refund record for the quoted
amount, a free run gives its credit back to the wallet's month.

### `POST /internal/runs/publish`

Publish a run.json by hand (`hyvo publish`). The body is one line of JSON metadata (`PublishMeta`:
`{ "hash", "sha256", "summary", "scenarioHash"?, "featured"? }`), a newline, then the exact run.json bytes (≤ 5 MB). As
with `complete`, the Worker checks `sha256` against the bytes and does not parse them unless `VERIFY_RUNS_IN_WORKER=1`.
With the oracle on and a `scenarioHash` sent, the run is committed on-chain like a paid one, which cannot be undone.
Publishing a run again commits one that went out before the oracle was on, unless it has been taken out of the gallery; a
commit that exists stays as it is.
`201` published, `200` already published with the same hash, `400 bad_request | invalid_run`, `409 conflict` (same
`runId`, different hash), `413 too_large`.

---

## LLM endpoint

### `POST /internal/llm/v1/chat/completions`

An OpenAI-compatible chat endpoint over Cloudflare Workers AI, for the engine: `LLM_BASE_URL=<api>/internal/llm/v1`,
`LLM_API_KEY=<LLM_TOKEN>`, `LLM_MODEL_NAME=@cf/...`. It needs no provider key and stays inside Cloudflare's free daily
allocation. `LLM_TOKEN` opens this route and nothing else, and the runner token does not open it: an LLM key travels
to whatever `LLM_BASE_URL` says, so it must not reach the job queue.

It reads `model` (`@cf/...`), `messages`, `temperature`, `max_tokens` and `response_format`, and answers in the OpenAI
shape with `usage`. `400 bad_request`, `401 unauthorized` (also when `LLM_TOKEN` is not set), `429 llm_quota` with
`Retry-After` when the free allocation is used up (it returns at 00:00 UTC), `502 llm_failed`, `503 llm_disabled`
without the AI binding.

---

## Background work

A cron runs every minute (`wrangler.jsonc` `triggers.crons`):

1. Return quiet or overdue jobs to the queue (as above).
2. Scan new blocks for `Paid` events: from the stored cursor (initially `PAYMENT_ROUTER_DEPLOY_BLOCK`) up to
   `latest − PAYMENT_CONFIRMATIONS`, in `LOG_RANGE_BLOCKS` windows, at most `LOG_RANGES_PER_RUN` per run.
3. Send pending oracle commits and confirm sent ones from their receipts. One processor holds a commit at a time. Before
   sending, the chain is read: a commit already on chain with the same hash is marked confirmed, one with another hash
   is flagged and never overwritten (the contract refuses a second commit anyway). A failed send is retried after
   2, 4, 8... minutes, at most one hour apart, until it goes through.
4. Delete expired nonces, sessions and rate-limit windows.

Locally: `wrangler dev --test-scheduled`, then `GET /__scheduled`.

---

## Money rules in the API

### Pricing

```
estimatedLlmCost = agents × rounds × COST_PER_AGENT_ROUND_USD + REPORT_COST_USD
price            = max(PRICE_FLOOR_USD, ceil_to(PRICE_STEP_USD, estimatedLlmCost × PRICE_MULTIPLIER × (1 − holderDiscount)))
maxCostUsd       = min(estimatedLlmCost × BUDGET_HEADROOM, price)         // the run's LLM budget
maxLlmCalls      = ceil((ceil(agents / BATCH_SIZE) × rounds + 3) × BUDGET_HEADROOM)
```

Defaults (`wrangler.jsonc`, a DeepSeek-class model): 0.0003 USD per agent-round, 0.02 report, ×2.5, floor $1, step $1,
headroom ×2. So 50 × 10 costs $1 with a $0.34 budget, and 500 × 20 costs $8 with a $6.04 budget. A run can never
spend more than its price; the engine stops cleanly at its budget and publishes a `partial` run.

On Workers AI (`apps/api/production.vars.json`, measured): 0.00005 per agent-round and 0.008 for the report, so 50 × 10
has a $0.066 budget. Its daily cap of $0.10 is what the free allocation is worth at list price, and it leaves room
for 840 agent-rounds per run, which `GET /v1/health` reports as `limits.maxDecisions`.

### Payment matching

A `Paid` event pays its order when the order exists and is unpaid, the token is the quoted token, the amount is at
least the quote and the event's timestamp is at most 5 minutes after `expiresAt`. An event and everything it settles
are one D1 transaction: the event's row, the order marked paid and its run queued, or the refund record. A failure
leaves nothing behind, so the next try settles it. Every event is recorded once (`<txHash>:<logIndex>`), whichever of
the scan or the user's check sees it first. Anything else gets a refund record: an unknown order, a second payment,
the wrong token, an underpayment or a late payment (`payment_unmatched`, the full amount), and the excess of an
overpayment (`overpaid`).

### Refunds

A run paid from a balance goes back to the balance by itself. Refund records (`due` → `sent`) are created for failed paid runs (`run_failed`, the
quoted amount) and for payments that cannot pay their order. The API never moves funds: the founder sends refunds from the treasury and records the
transaction (`POST /v1/admin/refunds/:id`).

### Daily spend cap

Each attempt reserves its job's `maxCostUsd` on its UTC start day; publishing replaces the reservation with the run's
real `usage.costUsd` (a failed attempt keeps its reservation). `GET /internal/jobs/next` hands out nothing that would
take the day past `DAILY_SPEND_CAP_USD`.

### Rate limits

Write endpoints are limited in D1 per IP or wallet (numbers above). Reads are cacheable; limiting them takes a
Cloudflare zone rule, which needs a domain on Cloudflare. On `*.workers.dev` only the plan's daily request limit
applies (`docs/RUNBOOK.md`). The reads that start work on the chain are limited in D1 as well: `GET /v1/oracle/:runId`,
every check that `GET /v1/check/:token` or `check_token` runs, and every read of Blockscout that `GET /v1/check/:token/holders` starts
(an answer from the cache is not counted).

---

## Verifying a run

Anyone can check that a published run is the one Hyvo committed on Robinhood Chain, without trusting the API. The
web app's `/oracle` page does exactly this in the browser (`apps/web/src/lib/verify.ts`), against the contract address
the app was built with (`VITE_ORACLE_ADDRESS`); it says so when it only has the API's word for the address.

1. **Get run.json.** `GET /v1/runs/:runId/artifact`, then fetch the `url`. These are the exact published bytes.
2. **Run hash.** Parse it, remove the top-level `hash` member only, canonicalize the rest with RFC 8785 (JCS: members
   sorted by UTF-16 code units, no whitespace, ECMAScript number formatting, UTF-8 output) and take keccak256
   (Ethereum's Keccak-256, not SHA3-256). Lowercase hex with `0x`. It must equal the file's `hash`.
3. **Scenario hash.** The same on the `scenario` member alone: `keccak256(utf8(JCS(run.scenario)))`.
4. **Run id as bytes32.** Decode the 26 characters after `run_` from Crockford base32
   (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) to a 128-bit number and write it big-endian into the low 16 bytes of a
   bytes32 (the high 16 bytes are zero).
5. **Read the commit.** Call `getCommit(bytes32)` on the HyvoOracle address on Robinhood Chain (chain id 4663). Take the
   address from `chain/deployments/4663.json` in the repo; `oracleAddress` of `GET /v1/oracle` is the API's own claim:

   ```
   function getCommit(bytes32 runId) view returns (
     (bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint64 committedAt, uint64 resolvedAt, bytes32 outcomeHash))
   ```

   For example with Foundry: `cast call <oracle> "getCommit(bytes32)((bytes32,bytes32,uint64,uint64,uint64,bytes32))"
   <runIdBytes32> --rpc-url https://rpc.mainnet.chain.robinhood.com`. `committedAt` is 0 for a run never committed.
6. **Compare.** `reportHash` must equal the run hash from step 2 and `scenarioHash` the hash from step 3. The
   `Committed` event of the same transaction carries the same values.

Test vectors to check an implementation (`packages/schema/test-vectors/`): `canonical.json` (55 JCS cases) and
`sample-run.json`, whose `sample-run.meta.json` gives

| | |
|---|---|
| `runId` | `run_01M6E22WG0NQFVT4Q4295NMG1Z` |
| run hash | `0xbc4e60035a1343aeb7490f30c62f54e465888e04f943232a6facd3b1d3a8dc62` |
| scenario hash | `0xf29b4ae64f5c60f4b42dde4fd31176e7439adcddc91c78b23e84e6af2a574930` |
| `runIdBytes32` | `0x0000000000000000000000000000000001a19c217200addfbd12e4124b5a403f` |

Reference implementations: TypeScript `hashRun`, `scenarioHash`, `runIdToBytes32` in
`packages/schema/src/hash.ts`; Python `hash_run`, `scenario_hash`, `run_id_to_bytes32` in
`engine/hyvo/runfile/canonical.py`. Full format rules: [`RUN_FORMAT.md`](RUN_FORMAT.md).

---

## `RunSummary`

Derived from `run.json` by the runner and stored in D1, so the gallery never reads KV. Python and TypeScript derive
the same summary: `packages/schema/test-vectors/*.summary.json`.

```jsonc
{
  "runId": "run_01J…",
  "title": "…",                      // scenario.title
  "createdAt": "…", "publishedAt": "…",
  "status": "complete",              // or "partial"
  "stopReason": null,
  "crowdSize": 50, "rounds": 10,
  "personaMix": { "sniper": 10, "holder": 15, "panic_seller": 10, "skeptic": 15 },
  "models": { "agents": "offline/rules-v1", "report": "offline/rules-v1" },
  "hash": "0x…",
  "featured": false,
  "market": {
    "symbol": "HYVX",
    "priceStart": "0.0001",          // world.initialMarket.price (decimal string)
    "priceEnd": "0.000123",          // last round's market.price
    "priceChangePct": 23.0,          // float, for display only
    "swaps": 182,                    // ok swaps
    "posts": 240
  },
  "sparkline": [0.0001, 0.00011],    // priceStart then each round's price, floats for drawing only
  "turningPointRound": 6,            // or null
  "summary": "…"                     // report.summary, at most 280 characters
}
```

## Later phases

Phase 6 adds `resolve` and the calibration page.
