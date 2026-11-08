# Hyvo — Product and Build Spec

> **Hyvo** is the project name (from "hive": thousands of agents acting as one crowd). Domain: `hyvo.run`. Token
> ticker: `$HYVO`. Everything in the project is in English: every file, code comment, commit message, UI string, doc and
> config.

---

## 0. How this spec is used

1. This file is the source of truth for what Hyvo is and how it is built.
2. MiroFish (section 6.1) was studied before anything was built on it. [`MIROFISH_NOTES.md`](MIROFISH_NOTES.md) explains how agents, actions, platforms, memory and the report agent are wired, with file paths. Hyvo extends MiroFish from `engine/hyvo/` and never edits `engine/mirofish/`.
3. Work goes phase by phase (section 14). A phase is done only when its definition of done passes, including tests.
4. Facts about external systems (Pons contracts, USDG address, RPC URLs, API limits) are never invented. Anything unknown goes to [`OPEN_ITEMS.md`](OPEN_ITEMS.md), with a config placeholder.
5. Work lands in small, working commits with clear messages.

---

## 1. What Hyvo is

Hyvo is a **parallel world for Robinhood Chain**: a fork of the chain populated by AI traders built on MiroFish. The agents read real narratives, post and argue on a simulated social feed, and **actually transact** against real AMM math on the fork. Every result is hashed on-chain before the real outcome is known, and sold to traders, bots, AI agents and contracts.

Four layers:

| Layer | Role | Stage |
|---|---|---|
| **Parallax** (the world) | Robinhood Chain fork + crowd of AI trader agents that post and swap | Stage 1 |
| **Oracle Mesh** (the output) | Report hashes committed on-chain; API, webhooks and MCP server | Stage 1 (hash), Stage 4 (full) |
| **Narrative Engine** (the brain) | Live knowledge graph of real narratives, news and on-chain events that seeds every run | Stage 3 |
| **dApp Dry Run** (developer mode) | Developers drop a contract into the world; AI users exercise it before mainnet | Stage 4 |

Plus **Wallet Clone** and **Rewind** in Stage 5.

Users: **traders** (see how a crowd reacts to a scenario, replay events), **bots and AI agents** (query the crowd through API/MCP), **developers** (Dry Run), **contracts** (read committed oracle results).

---

## 2. Hard constraints

- **Chain:** Robinhood Chain (Arbitrum Orbit L2, chain ID 4663, gas token ETH).
- **Token:** launched by the founder on **Pons** (not Bankr). Pons charges a 1% trading fee, 70% to the creator. The launch is done manually in the Pons UI, not by code.
- **Starting budget is zero** beyond a domain. Every running cost must be paid by user payments or by creator fees already received (section 12). Build so that Stage 1 runs on one machine and free tiers.
- **Web, API, database:** Cloudflare (Pages, Workers, D1, R2, Queues/Cron where free). Not Vercel.
- **Engine:** Python (MiroFish) + Foundry/anvil, running on a "runner" machine: a laptop first, a small server later. The runner **pulls** jobs from the API; it never needs inbound ports.
- **No external audit.** Every contract must hold **no user funds**, be non-upgradeable, minimal, and built on OpenZeppelin.
- **Non-custodial.** Hyvo never holds, approves or moves users' tokens. Wallet reads are read-only. Sign-in is a signature (SIWE), never a transaction.
- **Not financial advice.** Results are always called "synthetic crowd reactions". The product never says buy, sell, good token or bad token, and never predicts a price as fact.
- **No real private individuals.** Personas are archetypes. Wallet Clone only works on a wallet the user proves they own.
- **Design bar:** Linear / Stripe / Paradigm level polish. No generic AI-looking UI.
- **Tooling:** pnpm, Wrangler, git, Foundry, Python 3.11–3.12 with uv.

---

## 3. Architecture

```
                 ┌──────────────────────────────┐
  Users, bots,   │  Cloudflare                   │
  AI agents ───► │  apps/web   (Pages)           │
                 │  apps/api   (Worker + D1 + R2)│◄─── MCP clients
                 └───────────────┬──────────────┘
                     job queue   │  results, report hash
                 (runner pulls)  ▼
                 ┌──────────────────────────────┐
                 │  Runner (laptop → server)     │
                 │  engine/   MiroFish + hyvo   │
                 │  chain/    anvil fork per job │
                 └───────────────┬──────────────┘
                                 │ commit(reportHash)
                                 ▼
                 ┌──────────────────────────────┐
                 │  Robinhood Chain mainnet      │
                 │  HyvoOracle  (no funds)      │
                 │  PaymentRouter (no balance)   │
                 └──────────────────────────────┘
```

Rules:
- The **API is the source of truth** for jobs, payments, runs and users. The runner is a worker that can disappear at any time.
- The runner authenticates with a runner token, polls `GET /internal/jobs/next`, heartbeats while running, and uploads results to R2 through signed URLs.
- The **attester key** that commits report hashes lives only in the Worker (Wrangler secret), never on the runner.
- Each job gets a **fresh anvil instance** on its own port and data directory, destroyed after the job.

---

## 4. Repository layout

```
hyvo/
├── engine/                  # Python. MiroFish fork + Hyvo extensions
│   ├── mirofish/            # upstream code (git subtree or fork; keep upstream remote)
│   ├── hyvo/
│   │   ├── world/           # fork manager, market state, wallets
│   │   ├── actions/         # on-chain actions exposed to agents
│   │   ├── personas/        # persona archetypes and generator
│   │   ├── scenarios/       # seed builders (event text, real data)
│   │   ├── runner/          # job loop, budgets, heartbeat, upload
│   │   ├── report/          # report agent prompts, run.json writer
│   │   └── dryrun/          # Stage 4
│   └── tests/
├── chain/                   # Foundry
│   ├── src/HyvoOracle.sol
│   ├── src/PaymentRouter.sol
│   ├── src/test-assets/     # test ERC-20, Uniswap V2-style pair/router for forks
│   ├── script/
│   └── test/
├── apps/
│   ├── web/                 # Cloudflare Pages (React + Vite, or Astro with React islands)
│   └── api/                 # Cloudflare Worker (Hono), D1, R2, MCP endpoint
├── packages/
│   ├── schema/              # zod schemas + TS types for run.json, API payloads
│   └── sdk/                 # TypeScript SDK for the public API
├── docs/
│   ├── MIROFISH_NOTES.md
│   ├── OPEN_ITEMS.md
│   ├── RUNBOOK.md           # how to start the runner, rotate keys, refund
│   └── API.md
├── LICENSE
└── README.md
```

---

## 5. The run: core data model

A **run** is one simulation. Everything else is built around it.

### 5.1 Lifecycle

`quoted → paid → queued → running → reporting → committed → published` (or `failed → refunded`).

### 5.2 `run.json` (canonical artifact, schema in `packages/schema`)

```jsonc
{
  "runId": "run_01J...",              // ULID
  "version": 1,
  "createdAt": "2026-11-03T10:00:00Z",
  "scenario": {
    "title": "Pons token X lists with 5% creator tax",
    "seedText": "...",                  // user text or Narrative Engine seed
    "seedSources": [ { "kind": "url|onchain|user", "ref": "..." } ],
    "injectedEvents": [ { "round": 4, "text": "Rumor: dev wallet sold 20%" } ]
  },
  "world": {
    "chainId": 4663,
    "forkBlock": 12345678,
    "pools": [ { "address": "0x...", "token0": "0x...", "token1": "0x...", "kind": "v2-test|real" } ]
  },
  "crowd": {
    "size": 50,
    "personaMix": { "sniper": 10, "holder": 15, "panic_seller": 10, "skeptic": 15 },
    "model": { "agents": "provider/model", "report": "provider/model", "temperature": 0.8 }
  },
  "rounds": [
    {
      "n": 1,
      "posts": [ { "agentId": "a07", "text": "...", "replyTo": null, "likes": 3 } ],
      "actions": [ { "agentId": "a07", "kind": "swap_buy", "amountIn": "0.05", "txHash": "0x...", "status": "ok" } ],
      "market": { "price": "0.000123", "reserve0": "...", "reserve1": "...", "holders": 41 }
    }
  ],
  "report": {
    "summary": "...",
    "turningPoint": { "round": 6, "why": "..." },
    "sentimentByRound": [0.4, 0.5, ...],
    "objections": [ "..." ],
    "disclaimer": "Synthetic crowd reaction. Not a trading signal."
  },
  "usage": { "llmCalls": 1234, "inputTokens": 0, "outputTokens": 0, "costUsd": 0.31 },
  "hash": "0x..."                       // keccak256 of the canonical JSON without this field
}
```

- Canonicalize with sorted keys and no whitespace before hashing. Document it in `docs/API.md` so anyone can verify a hash.
- LLM output is nondeterministic, so runs are **replayable from logs**, not re-runnable. Store every agent output.

---

## 6. Engine (MiroFish + Hyvo extensions)

### 6.1 MiroFish

- Repository: `https://github.com/666ghj/MiroFish`. Built on OASIS (CAMEL-AI). Pipeline: graph building → environment setup (personas) → parallel simulation on Twitter-style and Reddit-style platforms → ReportAgent → deep interaction (chat with agents).
- It uses any OpenAI-SDK-compatible LLM (`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME`) and Zep Cloud for memory (`ZEP_API_KEY`).
- **Check the license first** and record it in `docs/OPEN_ITEMS.md`. If it is copyleft (for example AGPL), the hosted modifications must be published; plan for that.
- Keep upstream code separate from Hyvo code so upstream updates can be merged.

### 6.2 The world: fork manager (`engine/hyvo/world`)

- Start anvil with `--fork-url $RH_RPC_URL --fork-block-number $BLOCK --chain-id 4663 --port <free port>`.
- Stage 1 market: deploy a test ERC-20 and a **Uniswap V2-style pair** on the fork (simple, constant-product, fully understood). Later stages add real pools from the fork (see open items: Pons pool type).
- Fund agent wallets with `anvil_setBalance` and seed token balances by swapping or by direct test-token mints.
- Expose `MarketState`: price, reserves, holder count, last N swaps, each agent's balances.
- One anvil per job. Kill it and delete its state when the job ends or times out.

### 6.3 On-chain actions (`engine/hyvo/actions`)

Add these to the agents' action space alongside MiroFish's social actions:

| Action | Parameters | Effect |
|---|---|---|
| `swap_buy` | `amount_eth` (bounded by balance and a per-agent cap) | Real swap on the fork |
| `swap_sell` | `fraction` (0–1 of holdings) | Real swap on the fork |
| `hold` | — | No transaction |
| `check_market` | — | Returns `MarketState` into the agent's context |

- Each round the agent observes: its persona, recent feed posts, `MarketState`, its own balances and PnL. It chooses social actions and **at most one market action**.
- Validate every action server-side in Python: bounds, balance, slippage limit. Invalid actions become `hold` and are logged.
- Execute transactions with a Python EVM client (web3.py) against the fork; record tx hash and status.

### 6.4 Personas (`engine/hyvo/personas`)

Archetypes, each a short structured profile (goal, risk tolerance, time horizon, triggers, posting style, typical size):

- Stage 1 (four): `sniper`, `holder`, `panic_seller`, `skeptic`.
- Stage 2+ (add): `swing_trader`, `whale`, `kol_follower`, `market_maker_bot`, `stock_token_holder`, `newcomer`.
- Persona mix is a run parameter. Names are generated handles, never real people.

### 6.5 Scenarios (`engine/hyvo/scenarios`)

- From user text: title + seed text + optional injected events by round.
- From real data (Stage 3): Narrative Engine seed packs.
- Sanitize user text: strip URLs to plain text, cap length (e.g. 4,000 chars), and wrap it as quoted data in prompts. Agents have **no tools outside the fork**, so prompt injection in a scenario cannot reach anything real.

### 6.6 Runner (`engine/hyvo/runner`)

- Loop: poll API → claim job → heartbeat every 15 s → run → write `run.json` + report → upload to R2 → mark complete.
- **Budget enforcement:** each job carries `maxCostUsd` and `maxLlmCalls`. Count tokens per call; stop the run cleanly when either limit is reached and mark it `partial`.
- Batch agent decisions per round to cut calls. Cheap model for agents, stronger model only for the report.
- Timeout per job (configurable, default 30 min). On crash or timeout the API returns the job to the queue once, then marks it `failed`.
- CLI for local use: `hyvo run --scenario file.md --agents 50 --rounds 10`.

### 6.7 Report agent

- Uses MiroFish's ReportAgent, extended with market data: turning point round, sentiment by round, top objections, what moved price, and the fixed disclaimer.
- Banned words in output: "buy", "sell" as advice, "guaranteed", "will pump", "good token", "bad token". Enforce with a post-check that rewrites or flags.

---

## 7. Contracts (`chain/`)

Both contracts: Solidity, Foundry, OpenZeppelin, non-upgradeable, **no stored user funds**, no `selfdestruct`, no delegatecall, no arbitrary calls.

### 7.1 `HyvoOracle.sol`

```
commit(bytes32 runId, bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt)  // attester only
resolve(bytes32 runId, bytes32 outcomeHash, string calldata outcomeURI)            // attester only, after resolvesAt (Stage 4)
getCommit(bytes32 runId) view returns (Commit)
events Committed(runId, reportHash, scenarioHash, resolvesAt, timestamp), Resolved(runId, outcomeHash, outcomeURI)
```
- A `runId` can be committed once. Roles: `owner` (Safe multisig, can rotate `attester`), `attester` (Worker key).
- Tests: commit once, double commit reverts, non-attester reverts, resolve before `resolvesAt` reverts, attester rotation.

### 7.2 `PaymentRouter.sol`

```
pay(bytes32 orderId, address token, uint256 amount)   // transferFrom(user → treasury), emits Paid
event Paid(orderId, payer, token, amount, timestamp)
```
- Forwards funds directly to the `treasury` address in the same call. The contract balance must always be zero.
- Allowed tokens: USDG and the Hyvo token (owner sets list). `orderId` can be paid once.
- Tests: forwarding, zero balance invariant (fuzz), duplicate `orderId` reverts, disallowed token reverts.

### 7.3 Required before mainnet

Unit tests for every function and revert path, fuzz tests, `forge coverage` near 100% on both contracts, Slither with no medium+ findings, deploy scripts with addresses written to `chain/deployments/4663.json`.

---

## 8. API (`apps/api`, Cloudflare Worker)

Hono on Workers, D1 for state, R2 for run artifacts, Wrangler secrets for keys.

### 8.1 Public endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/siwe/nonce`, `/v1/auth/siwe/verify` | Sign-In with Ethereum |
| POST | `/v1/quotes` | Price a run (size, rounds, options) → `orderId`, amount, expiry |
| POST | `/v1/runs` | Create a run after payment (`orderId`) or with holder free credit |
| GET | `/v1/runs/:id` | Status + summary |
| GET | `/v1/runs/:id/artifact` | Signed URL to `run.json` |
| POST | `/v1/runs/:id/ask` | Ask one agent or the report agent a follow-up (paid per call, Stage 2+) |
| GET | `/v1/runs` | Public gallery (published runs) |
| GET | `/v1/oracle/:runId` | On-chain commit + verification data |
| POST | `/v1/webhooks` | Register a webhook (Stage 3+) |
| POST | `/v1/keys` | API keys for bots (Stage 3+) |

### 8.2 Internal endpoints (runner token only)

`GET /internal/jobs/next`, `POST /internal/jobs/:id/heartbeat`, `POST /internal/jobs/:id/upload-url`, `POST /internal/jobs/:id/complete`, `POST /internal/jobs/:id/fail`.

### 8.3 Payments

- Watch `PaymentRouter.Paid` events (cron every minute, or on demand when a user submits a tx hash). Match `orderId`, amount, token, expiry. Mark the order paid.
- Price = `ceil(estimatedLlmCost × 2.5)` with a floor. Store the formula in config.
- Holder benefit: wallets holding at least `HOLDER_MIN` Hyvo tokens both now and in the snapshot 24 h ago get `FREE_RUNS_PER_MONTH` small runs and a discount. No yield, no payouts.
- Failed runs: mark `refund_due`; refunds are sent manually from the treasury and recorded (`docs/RUNBOOK.md`). Automate later.

### 8.4 Oracle commits

When a run completes, the Worker computes the canonical hash, verifies it matches the runner's, and calls `HyvoOracle.commit` with the attester key. Store the tx hash on the run.

### 8.5 MCP server (Stage 3)

Remote MCP endpoint on the Worker. Tools:
- `create_run(scenario, size, rounds)` → quote + payment instructions, or runs immediately with a prepaid API key balance
- `get_run(runId)`
- `ask_agent(runId, agentId, question)`
- `list_recent_runs(filter)`
- `verify_run(runId)` → hash check against the on-chain commit

Prepaid balances for API keys are topped up through `PaymentRouter` (the balance is an accounting entry in D1, the funds are in the treasury).

### 8.6 Security

Rate limits per IP, wallet and API key. Input validation with zod. CORS locked to the web origin for browser routes. All secrets in Wrangler secrets. Structured logs without secrets or full user text.

---

## 9. Web app (`apps/web`)

### 9.1 Pages

| Route | Content | Stage |
|---|---|---|
| `/` | Hero = a live replay of the best run; one-line explanation; "Run a simulation" | 1 |
| `/run/:id` | **Replay**: price chart, agent feed and swap list in sync, with a scrubber; report; oracle verification badge | 1 |
| `/new` | Scenario form, size picker, quote, pay with wallet | 1 |
| `/runs` | Gallery of published runs | 1 |
| `/oracle` | Ledger of commits with verification | 1 |
| `/docs` | API, MCP, hash verification | 3 |
| `/dryrun` | Dry Run submission and reports | 4 |
| `/clone`, `/rewind` | Wallet Clone and Rewind | 5 |

### 9.2 Design direction

- Calm, precise, data-forward. The replay is the hero and the signature element; everything around it is quiet.
- One typeface family plus a monospace only where numbers need alignment. Choose deliberately; no default stacks.
- Dark and light themes from tokens. Mobile-first; the replay must work on a phone.
- Agent posts look like a feed, but clearly labeled "synthetic agent" on every post.
- Every results surface shows the disclaimer: "Synthetic crowd reaction. Not a trading signal."
- Wallet connect with a standard library (wagmi/viem) on chain 4663.

---

## 10. Narrative Engine (Stage 3)

- **Sources:** new Pons launches and large swaps (on-chain via RPC/indexer), Robinhood stock token price moves, Farcaster casts (via a Farcaster API), public news RSS. X data is expensive; skip it unless revenue covers it.
- **Graph:** use MiroFish's graph building (GraphRAG + Zep) to keep a rolling knowledge graph of tokens, narratives and events. Prune entries older than a configurable window.
- **Seed packs:** a cron job builds daily seed packs (top narratives, notable launches, notable moves) that become scenarios.
- **Daily run:** one funded daily simulation from the day's seed pack, published as a public report.
- **Swarm Cast:** turn the daily report into a short post thread for X and Farcaster (text first; audio/video later).
- **Autopsy:** when a tracked token moves more than a threshold, build a scenario from the events before the move and run it; publish "what the crowd reacted to".

---

## 11. Stage 4–5 features

### 11.1 dApp Dry Run (Stage 4)

- Developer submits: verified contract address on Robinhood Chain **or** bytecode + ABI to deploy on the fork, a plain-language description of the dApp, and optional invariants (Solidity view functions that must stay true).
- Hyvo generates an action space from the ABI (non-admin, state-changing functions) with parameter bounds, and a crowd of user personas (newcomer, power user, adversarial tester, whale).
- Agents use the dApp for N rounds. Record every call, revert reason, gas, and state change.
- Report: confusing flows (repeated reverts), invariant violations, unusual balance changes, gas outliers, and agent feedback in plain language.
- Untrusted bytecode runs only inside the per-job anvil sandbox. The runner process has no keys to anything real.

### 11.2 Oracle Mesh full (Stage 4)

- Scenario questions with a resolution date (`resolvesAt`). After the date, the outcome is recorded with `resolve`.
- Public calibration page: how often committed crowd expectations matched outcomes. Show misses as prominently as hits.
- Contracts can read commits directly; bots subscribe by webhook.

### 11.3 Wallet Clone (Stage 5)

- Only after SIWE proves ownership. Read the wallet's history (swaps, hold times, sizes, launch timing) and derive a persona profile from statistics, not from guesses about the person.
- The clone joins runs as one agent; the user sees how "their style" behaves in the crowd.
- Delete clone data on request. Never build clones of wallets the user does not control.

### 11.4 Rewind (Stage 5)

- Fork at a historical block, rebuild the crowd, inject an altered event (earlier rumor, missing whale sell), run, and compare with what actually happened after that block.

---

## 12. Money rules (enforced in code and config)

1. **Pay before run.** A run starts only after payment is confirmed or a holder credit is consumed.
2. **Spend caps everywhere.** Daily cap on every LLM provider dashboard. Per-run `maxCostUsd` and `maxLlmCalls` in code. A global daily cap in the API that pauses the queue when hit.
3. **Fixed costs ≤ 50% of the last 30 days of creator fees.** Stage gates (section 14) follow this rule.
4. **Rough LLM cost:** one agent decision ≈ $0.0003 on a cheap model such as DeepSeek V4 Flash ($0.14 per million input tokens, $0.28 per million output). 50 agents × 10 rounds ≈ $0.15; 500 × 20 ≈ $3–4 plus the report. Recheck prices before setting quotes.
5. **Creator fee math:** the creator receives 0.7% of Pons trading volume. $10,000 daily volume ≈ $70/day.
6. **Token utility only:** free runs, queue priority, discounts. The token never pays profits.

---

## 13. Quality, safety and compliance

- **Tests:** pytest for the engine (actions, budgets, fork manager with a local anvil), vitest for API and schema, Foundry for contracts, Playwright smoke tests for the web replay.
- **Golden run:** keep one recorded `run.json` in the repo as a fixture; the web replay and hash verification are tested against it.
- **Copy rules:** "synthetic crowd reaction" everywhere; no buy/sell language; no predictions stated as facts.
- **Jurisdictions:** Robinhood stock tokens are not available to residents of the US, Canada, the UK or Switzerland. Hyvo simulates; it does not sell stock tokens. Do not build features that route users to buy them.
- **Privacy:** no profiles of real private individuals; Wallet Clone is self-only.
- **Observability:** per-run usage and cost in D1; a simple admin page (founder wallet only) with queue, spend today, fees received, failures, refunds due.

---

## 14. Phases and definitions of done

Each phase ends with tests passing. Gates after Phase 3 are revenue gates, not dates.

**Founder's decision, 2026-11-06:** the gates below are lifted. Phases 4 to 7 are built now and the token launches last,
after Phase 7. Creator fees only exist after the launch, so with the launch last the gates could never open. Everything still
stays on free plans until the founder approves a cost, so what needs money or a machine that is always on is built, tested as
far as it can be, and marked as waiting (`docs/OPEN_ITEMS.md` item 22).

### Phase 1 — Engine core (runs on the laptop)
- MiroFish runs locally with an OpenAI-compatible free-tier or cheap model.
- Fork manager starts/stops anvil per job; test pair deployed; wallets funded.
- On-chain actions integrated; four personas; budgets enforced.
- **Done when:** `hyvo run` with 50 agents × 10 rounds produces a valid `run.json` where agents post and swap and the recorded price matches the swaps; the run stops cleanly when its budget is hit.

### Phase 2 — Replay and gallery
- `packages/schema`, `apps/web` replay page, gallery, home hero; `apps/api` serving published runs from R2.
- **Done when:** the golden run replays correctly on desktop and phone, and a new local run can be published with one command.

### Phase 3 — Payments, oracle, launch readiness
- `HyvoOracle` and `PaymentRouter` with full tests and Slither clean, deployed on Robinhood Chain.
- Quotes, payment detection, holder credits, runner job queue (pull model), oracle commits from the Worker, refund records, admin page, disclaimers.
- **Done when:** a test user pays USDG through `PaymentRouter`, the laptop runner picks up the job, the run publishes, and its hash is committed on-chain and verifies on `/oracle`.
- Then the founder launches the token on Pons with the best replay as the launch asset.

### Gate A — 30-day creator fees ≥ $200 and ≥ 20 paid runs
### Phase 4 — Always-on runner
- Move the runner to a small server (Docker Compose: engine + anvil). Health checks, auto-restart, log rotation.
- One funded daily public run.
- **Done when:** the runner survives a restart without losing jobs and the daily run publishes unattended for 7 days.

### Gate B — 30-day creator fees ≥ $500
### Phase 5 — Narrative Engine, API and MCP
- Sources, rolling graph, seed packs, Swarm Cast text, Autopsy.
- API keys, prepaid balances, webhooks, MCP server, TypeScript SDK, `/docs`.
- **Done when:** an external MCP client creates a run, pays from a prepaid balance, and verifies the hash; a daily seed pack produces a published run and a post thread.

### Gate C — 30-day creator fees ≥ $1,500
### Phase 6 — Oracle Mesh full + dApp Dry Run
- `resolve` flow, calibration page, scenario questions with resolution dates.
- Dry Run submissions, ABI-derived action spaces, user personas, invariant checks, reports.
- **Done when:** a sample dApp with a planted bug gets a Dry Run report that surfaces the bug; a resolved scenario appears on the calibration page.

### Gate D — 30-day creator fees ≥ $3,000
### Phase 7 — Wallet Clone, Rewind, scale
- Clone (self-only), Rewind at historical blocks, crowds of 1,000+ agents with batching, more personas.
- **Done when:** a user clones their own wallet, runs it in a crowd, and rewinds a past event with one changed variable.

---

## 15. Configuration (`.env.example` and Wrangler vars)

```
# Engine / runner
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL_NAME=              # agents
REPORT_MODEL_NAME=           # report agent
ZEP_API_KEY=
RH_RPC_URL=                  # Robinhood Chain RPC
HYVO_API_URL=
RUNNER_TOKEN=
MAX_COST_USD_DEFAULT=0.50
MAX_LLM_CALLS_DEFAULT=2000

# Worker (secrets)
ATTESTER_PRIVATE_KEY=
RUNNER_TOKEN=
SIWE_DOMAIN=
ORACLE_ADDRESS=
PAYMENT_ROUTER_ADDRESS=
USDG_ADDRESS=
HYVO_TOKEN_ADDRESS=
TREASURY_ADDRESS=
HOLDER_MIN=
FREE_RUNS_PER_MONTH=
DAILY_SPEND_CAP_USD=
```

---

## 16. Open items to verify (copy into `docs/OPEN_ITEMS.md`)

1. MiroFish license and its implications for hosting modified code.
2. How MiroFish's agent action space is extended in practice (document in `MIROFISH_NOTES.md`).
3. Robinhood Chain public RPC URL, rate limits, and whether `anvil --fork-url` works smoothly against it.
4. USDG contract address on Robinhood Chain.
5. Pons pool type (bonding curve, then which pool after graduation) for simulating real Pons tokens on the fork.
6. Zep Cloud free-tier allowance and pricing; alternative self-hosted memory if needed.
7. Current free-tier limits of the chosen LLM providers.
8. Farcaster data API choice and its free limits (Stage 3).
9. Availability and renewal price of `hyvo.tech`, and availability of the X handle.
