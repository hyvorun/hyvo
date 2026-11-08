# engine

Hyvo's Python engine: a crowd of AI trader agents on a simulated social feed (OASIS, the substrate of
[MiroFish](https://github.com/666ghj/MiroFish)) that swap against a constant-product test pool on a
fresh local anvil chain (chain ID 4663, optionally a fork of Robinhood Chain). One run writes one
`run.json`, hashed as described in [`docs/RUN_FORMAT.md`](../docs/RUN_FORMAT.md).

Results are synthetic crowd reactions. Not a trading signal.

- `hyvo/` is Hyvo code; `mirofish/` is the upstream MiroFish subtree (AGPL-3.0, never edited for
  Hyvo features). How the two fit together: [`docs/MIROFISH_NOTES.md`](../docs/MIROFISH_NOTES.md).
- Packages: `world` (anvil, test market, wallets, price replay), `actions` (swap_buy, swap_sell,
  hold, check_market), `decisions` (batched per-round decisions), `llm` (clients, budget, log),
  `personas`, `scenarios`, `report` (report agent and copy guard), `runfile` (run.json models,
  hashing, IO), `sim` (OASIS social world and the simulation loop), `cli.py` (the `hyvo` command).

## Setup

Requirements: [uv](https://docs.astral.sh/uv/) (it installs Python 3.11), and Foundry 1.7.1 for
`anvil` on `PATH` (`foundryup`). The contract artifacts the engine deploys are committed in
`chain/artifacts/`; nothing in `chain/` has to be built to run the engine.

```sh
cd engine
uv sync                      # Python 3.11 env pinned to the MiroFish lock (torch is never imported)
uv run hyvo --help
```

Settings come from the environment and an optional `.env` at the **repo root** (copy
[`.env.example`](../.env.example)); a variable set in the environment wins over `.env`.

## Offline model or a real model

Without `LLM_API_KEY` every run uses the offline rules model: deterministic persona rules, no
network, zero cost, labeled `offline/rules-v1` in `run.json` (`crowd.model`). `--offline` forces it
even when a key is set. The CLI always says which model a run uses.

For a real model, set an OpenAI-compatible endpoint in `.env`. DeepSeek example:

```sh
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL_NAME=deepseek-flash
# REPORT_MODEL_NAME=deepseek-v4-pro    # optional stronger report model; empty = LLM_MODEL_NAME
```

- Cloudflare Workers AI needs no provider key: the API has an OpenAI-compatible endpoint over its AI
  binding, and `pnpm --filter @hyvo/api deploy:cloudflare` writes these settings to `.env`:
  `LLM_API_KEY=<the Worker's LLM_TOKEN>`, `LLM_BASE_URL=<API URL>/internal/llm/v1`,
  `LLM_MODEL_NAME=@cf/meta/llama-3.1-8b-instruct-fp8-fast`,
  `REPORT_MODEL_NAME=@cf/meta/llama-3.3-70b-instruct-fp8-fast`. A 50 x 10 run uses 2,200 to 2,800 of the
  10,000 free neurons a day (docs/OPEN_ITEMS.md item 11).
- Prices are needed to enforce the cost budget. Models in `hyvo/llm/pricing.py` (DeepSeek
  `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, peak prices; the Workers AI models above and
  others at list price) need nothing more; for any
  other model set `LLM_PRICE_INPUT_PER_M` / `LLM_PRICE_OUTPUT_PER_M` (and `REPORT_PRICE_*` for a
  different report model), in USD per million tokens. Hyvo refuses to run a paid model without a price.
- DeepSeek's thinking mode is switched off on every request (it bills reasoning tokens and ignores
  the temperature).
- Rough cost: a 50 x 10 run makes 50 agent calls (one per batch of 10 agents per round) plus 1-3
  report calls, about 230k prompt tokens in total. At the `deepseek-flash` peak prices in
  `pricing.py` ($0.30 / $1.20 per million input / output tokens) that is roughly $0.10, well inside
  the default $0.50 budget; `usage` in `run.json` and `llm-log.jsonl` show the real numbers. Set a
  daily spend cap on the provider dashboard too.
- Every call is checked against the run budget before it is sent: `--max-cost-usd` and
  `--max-llm-calls` (defaults `MAX_COST_USD_DEFAULT=0.50`, `MAX_LLM_CALLS_DEFAULT=2000`). Two calls and
  10% of the cost limit stay reserved for the report. When the agents' share runs out, the agents left
  in that round hold (`note: "budget_exhausted"`), the round is finished, and the run stops as
  `partial` with `stopReason` `max_llm_calls` or `max_cost_usd`. It still gets a report and a valid,
  hashed `run.json`. A round starts only if the agents can still pay for a call, and a round in which
  no batch got a decision is not recorded, so `run.json` never contains a round nobody decided; a
  budget too small for even round 1 fails the run (no `run.json`). When the budget cannot pay for
  every batch of a round, that round's batches run one at a time in agent order, so the same seed and
  limits always hold the same agents.

## `hyvo run`

```sh
uv run hyvo run --scenario examples/scenarios/pons-creator-tax.md --agents 50 --rounds 10
```

| Option | Default | Meaning |
|---|---|---|
| `--scenario FILE`, `-s` | required | Scenario Markdown: front matter (`title`, optional `token_symbol`, `token_name`, `liquidity_eth`, `liquidity_tokens`, `fee_bps`), seed text, optional `## Events` with `- round N: text` lines. See `hyvo/scenarios/parse.py`. |
| `--agents N` | 50 | Crowd size (1-9,999). |
| `--rounds N` | 10 | Rounds to play. Events must fall within them. |
| `--mix sniper=10,...` | 10:15:10:15 | Persona mix (`sniper`, `holder`, `panic_seller`, `skeptic`), summing to `--agents`. |
| `--batch-size N` | 10 | Agents decided per LLM call. |
| `--max-concurrency N` | 4 | LLM calls in flight at once. |
| `--max-cost-usd X`, `--max-llm-calls N` | settings | The run budget (above). |
| `--offline` | off | Offline rules model even with a key. |
| `--fork` / `--no-fork` | fork when `RH_RPC_URL` is set | Fork mode (below). |
| `--fork-block N` | latest | Block to fork at (needs a fork). |
| `--seed N` | random | Seeds the crowd, wallet addresses, the offline model and the order of market actions. The seed is printed and logged. |
| `--out DIR` | `HYVO_RUNS_DIR` or `engine/.runs` | Parent of the run directory. |
| `--timeout-min M` | 30 | Wall-clock limit, checked between rounds: the run stops at the next round boundary as `partial` with `stopReason: "timeout"`. |
| `--max-slippage-bps N` | 1500 | A swap reverts when it would fill more than this below the output expected at the round's decision snapshot (`reverted` in `run.json`). |
| `--quiet`, `-q` / `--debug` | | No per-round progress / tracebacks and engine log messages. |

It prints the run id, the status (with the stop reason of a partial run), the `run.json` path, the
hash, and the LLM calls with tokens and cost. Exit codes: `0` for a complete **or** partial run, `2` for
bad input (scenario, options, settings), `1` when the run fails, `130` when interrupted. Errors are one
short message; `--debug` adds the traceback.

From Python:

```python
from hyvo.sim import SimConfig, run_simulation

outcome = run_simulation(SimConfig(scenario="examples/scenarios/pons-creator-tax.md", seed=7))
print(outcome.status, outcome.stop_reason, outcome.path, outcome.hash, outcome.usage)
```

`run_simulation(config, settings=None, *, clients=None, progress=None)` blocks until the run is
over; `run_simulation_async` is the same for callers that already run an event loop. `clients` takes
`(agents_client, report_client)` instead of the ones built from settings (tests use it).

### What one run does

1. Checks that need nothing running: the scenario file, the persona mix, fork options, prices,
   and the `run.json` JSON Schema (`packages/schema/run.schema.json` or `HYVO_RUN_SCHEMA`); a
   problem exits with code 2 before any process or directory is created. Then a run id (ULID) and
   the run directory `<out>/<runId>/`; one budget meter shared by the agents and report clients,
   which log every call to `llm-log.jsonl`.
2. The crowd (generated handles, personas, starting ETH); a fresh anvil; the test market (TestWETH,
   TestToken, HyvoV2Pair, HyvoV2Router) with the scenario's overrides; one wallet per agent, funded
   with its ETH, seeded with tokens (persona token weight x 1% of the pool's initial token liquidity:
   holders 1%, panic sellers 0.6%) and approved on the router; the OASIS social world. The pool and
   every agent's balances at this point are recorded as `world.initialMarket` and
   `crowd.agents[].startEth`/`startTokens`, so anyone can replay the whole run.
3. Each round: the decision snapshot of the market; the round's injected events; the shared feed
   (the 10 hottest posts with up to 2 replies each) and the market panel; one card per agent
   (balances, PnL, own posts, replies to it, and the detailed market if it chose `check_market` the
   round before); batches decided concurrently; posts, replies and likes through OASIS in agent
   order; then exactly one market action per agent, executed one by one in a seeded shuffle of the
   crowd and recorded in that order. The pool after the round is checked against the engine's own
   replay of the round's swaps.
4. At the end: posts with their final likes, the report, `run.json` (validated, hashed, written
   atomically), then the hash, the models, the JSON Schema and the price replay are checked on the
   written file. Any disagreement is an engine bug: the file is renamed `run.rejected.json` and the
   run fails. Teardown always runs: the social world is closed and anvil is stopped and its data
   directory deleted, so the run directory can be deleted (also on Windows).

### Modeling defaults

These are simulation choices, not facts about Robinhood Chain; change them per run or in code.

- **Slippage limit 1500 bps** (`--max-slippage-bps`). Agents decide on the round-start price and
  execute one after another; with a 500 bps limit, most round-1 buys on a thin example pool reverted
  and trading died out. 15% is a common setting for thin meme-token pools.
- **Starting tokens**: persona token weight x 1% of the pool's initial token liquidity (holders 1%,
  panic sellers 0.6%, snipers and skeptics none). Recorded per agent as `startTokens`.
- **Posts state intent**: posts go out before the round's swaps execute and a swap can revert, so the
  prompt (`agent_decisions/v2`) and the offline templates phrase trades as intent ("adding 0.05 ETH").
- **Likes**: each agent's card lists the shown posts it already liked; repeats are dropped.
- **A line is said once in a run**: cheap models copy the posts they are shown and give two agents of a
  batch the same words, so the prompt asks for something new or no post, and the engine drops a post or
  reply whose words anyone already posted (case and spacing do not count as a change; event
  `post_repeat_dropped`). The rest of the decision still counts.

## `hyvo verify`

```sh
uv run hyvo verify .runs/run_01M6.../run.json     # or the run directory
```

Checks the hash (RFC 8785 + keccak256), the JSON Schema (`packages/schema/run.schema.json`, override
with `HYVO_RUN_SCHEMA`), the model rules (`hyvo/runfile/models.py`: one action per agent per round,
replies to earlier posts, persona mix, ...) and replays every recorded swap with the router's integer
math against the recorded prices and reserves. Exit code `0` when everything passes, `1` otherwise.

## `hyvo publish`

```sh
RUNNER_TOKEN=... uv run hyvo publish .runs/run_01M6... --api http://127.0.0.1:8787 [--featured]
```

Verifies the run locally (everything `hyvo verify` checks), then sends its exact bytes and its
metadata to the API (`POST /internal/runs/publish`). The Worker does not re-hash them on the Workers
Free plan (docs/OPEN_ITEMS.md item 21), so this local check is the one that counts. For runs played by
hand; paid runs publish through the runner.

## `hyvo runner`

```sh
RUNNER_TOKEN=... uv run python -m hyvo runner --api https://<api> [--once] [--offline] [--no-fork]
```

Pulls paid jobs from the API (`GET /internal/jobs/next`) and plays each one in a child process
(`python -m hyvo.runner.child`): heartbeats every 15 s with the latest round, kills the run at the
job's timeout or when the API says the lease is lost, verifies run.json as `hyvo verify` does, uploads
it to the signed URL (without the runner token) and calls `complete` with its metadata, or `fail`. It
survives API restarts (backoff on
polls, retried heartbeats and delivery). The job's spec is parsed strictly
(`hyvo/runner/models.py`): the runner plays only what was ordered. Details and operations:
[`docs/RUNBOOK.md`](../docs/RUNBOOK.md), "The runner"; the contract: [`docs/API.md`](../docs/API.md),
"Runner jobs". `SimConfig.run_id` makes the run carry the job's id.

## Outputs

`<out>/<runId>/`:

| File | Content |
|---|---|
| `run.json` | The run (`docs/RUN_FORMAT.md`), hashed. Actions are listed in execution order. |
| `llm-log.jsonl` | Every LLM request and raw response with tokens, cost and latency; refused calls have `error: "budget_exceeded: <reason>"`. Runs are replayable from this log, not re-runnable. No keys or settings. |
| `events.jsonl` | Engine events: `run_started` (seed, parameters), `world_ready` (anvil, contract addresses), `round_started` / `round_finished`, `batch` (every parsed decision), `budget_exhausted`, `llm_request_failed`, `social_rejected`, `action` (every swap with tx hash and status, every check and invalid action), `stopped`, `report`, `run_finished` / `run_failed`, `teardown`. |
| `social.db` | The OASIS SQLite database of the run's feed. |

## Fork mode

With `RH_RPC_URL` set, anvil forks it (`--fork-url`, at `--fork-block` when given) and
`world.forkBlock` records the block; `--no-fork` ignores the URL. Stage 1 still deploys the Hyvo test
pair into the fork, so the fork adds real chain state, not real pools.

Robinhood Chain behind some ISPs ([`docs/OPEN_ITEMS.md`](../docs/OPEN_ITEMS.md) items 3 and 14): the
ISP rewrites DNS for every `*.robinhood.com` host, so the official RPC does not resolve. Use
`RH_RPC_URL=https://robinhood.drpc.org` (keyless free tier; it keeps about 2.3 days of state, so older
fork blocks fail; batches of at most 3 calls). anvil 1.7.1 crashed in 1 of 3 forks there on a
transient dRPC error. A forked start is therefore retried twice, and `RH_RPC_URL_FALLBACK` (for
example an archive-capable Alchemy URL) is passed as a second `--fork-url`, across which anvil
spreads its requests. A crash later in the run fails it with a short message; start it again.

anvil is bound to the engine process by the OS (a kill-on-close job object on Windows,
`PR_SET_PDEATHSIG` on Linux), so even a hard kill of the engine leaves no anvil running; the next
start sweeps leftover data directories of dead owners in `engine/.anvil/`.

## Windows notes

- `PYTHONUTF8=1` is recommended (Python then reads and writes UTF-8 everywhere). The `hyvo` CLI is
  safe without it: on a cp1252 console it replaces characters the console cannot show, and a pipe or
  file gets UTF-8.
- OASIS writes its log to `engine/.oasis-logs/oasis.log`; anvil's data lives in `engine/.anvil/<id>/`
  only while a run is alive. Both are gitignored, as is `engine/.runs/`.
- The first run in a process imports OASIS (about 4 s); a 50 x 10 offline run takes about 20-30 s.

## Tests

```sh
cd engine
uv run --no-sync python -m pytest -q            # the full suite
uv run --no-sync python -m pytest -q -m "not slow"   # skip whole simulation runs
uv run --no-sync ruff check hyvo tests
```

Markers: `anvil` (needs Foundry; skipped automatically without `anvil` on `PATH`), `oasis` (imports
OASIS), `slow` (whole simulation runs). The Phase 1 definition of done is
`tests/sim/test_sim_dod.py`: 50 agents x 10 rounds offline without a fork, through `run_simulation`
and through the real `hyvo` command in a subprocess. No test reaches the network: the real-model
path is tested against an `httpx.MockTransport` endpoint (`tests/sim/test_sim_openai_path.py`).
