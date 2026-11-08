# Runbook

How to run Hyvo locally and operate it: the local stack, the runner, the end-to-end test, keys, refunds and the
go-live checklist. The API contract is [`API.md`](API.md).

## Prerequisites

- Node 22+ and pnpm 11, Python 3.11 with uv, Foundry (anvil, forge), Wrangler (installed per package by pnpm).
- `pnpm install` at the repo root; `cd engine && uv sync`.
- Browser tests: `cd apps/web && npx playwright install chromium`.

## Local stack: engine → API → web

1. **API** (Cloudflare Worker with local D1 and KV):

   ```
   cd apps/api
   cp .dev.vars.example .dev.vars          # tokens for local use
   npx wrangler d1 migrations apply hyvo --local
   npx wrangler dev --port 8787 --test-scheduled   # http://127.0.0.1:8787/v1/health
   ```

   Local state lives in `apps/api/.wrangler/state` (gitignored). Delete it to start empty. After pulling new
   migrations, run the `migrations apply` line again. With `--test-scheduled`, `GET /__scheduled` runs the cron once.
   Without chain settings (`RPC_URLS`, addresses) payments, oracle commits and holder benefits are off; the gallery
   and replay work as before.

   Only Workers AI is remote: with `LLM_TOKEN` set in `.dev.vars` and a Wrangler login, the local LLM endpoint spends
   the account's real daily neurons. Tests and the end-to-end test do not touch it.

2. **A run, published with one command** (offline model; set `LLM_*` in `.env` for a real model, see
   [`.env.example`](../.env.example)):

   ```
   cd engine
   uv run hyvo run --scenario examples/scenarios/pons-creator-tax.md --agents 50 --rounds 10 --offline
   RUNNER_TOKEN=<value from .dev.vars> uv run hyvo publish .runs/<runId> --api http://127.0.0.1:8787 --featured
   ```

   `hyvo publish` verifies the run locally (hash, schema, rules, price replay) before sending its exact bytes.
   The golden run can be published the same way: `uv run hyvo publish ../fixtures/golden-run.json --api ...`.

3. **Web** (Vite dev server):

   ```
   cd apps/web
   pnpm dev                                # http://localhost:5173
   ```

   Build-time settings: `VITE_API_URL` (default `http://127.0.0.1:8787`), `VITE_RPC_URLS` (comma-separated, default
   the public Robinhood Chain endpoints), `VITE_EXPLORER_URL` (default Blockscout), `VITE_ORACLE_ADDRESS` (the address
   `/oracle` checks against; without it the page uses the API's and says so). The API answers CORS only for
   `WEB_ORIGIN` and accepts SIWE messages only for `SIWE_DOMAIN` (`http://localhost:5173` / `localhost:5173` in
   `apps/api/wrangler.jsonc`).

## The runner

The runner pulls paid jobs from the API and plays each in a child process (SPEC 6.6, `engine/hyvo/runner`).

```
cd engine
RUNNER_TOKEN=<token> uv run python -m hyvo runner --api https://<api>      # Ctrl+C stops
```

Options: `--once` (one job, then exit), `--offline` (offline rules model), `--fork/--no-fork` (default: fork
`RH_RPC_URL` when it is set), `--work-dir` (default `<runs dir>/runner`), `--poll-interval` (seconds, default 15).
`HYVO_API_URL` can replace `--api`. The token is read from the environment or `.env`, never from the command line, and
the child process is not handed it. (`uv run hyvo runner` works too where Windows Application Control allows the
`hyvo.exe` launcher; `python -m hyvo` always works.)

What it does per job:

- writes `<work dir>/<runId>/attempt-<n>/job.json`, starts `python -m hyvo.runner.child` and logs its output to
  `child.log` in the same folder; run.json lands in `runs/<runId>/` there;
- heartbeats every 15 s with the latest round; a `409 lease_lost` answer kills the run (the job went back to the
  queue or ended elsewhere);
- gives the engine the job timeout minus 120 s (it then stops at a round boundary and writes a partial run) and kills
  it at the job timeout; anvil dies with the child process;
- verifies run.json locally (hash, schema, rules, price replay), uploads it to the signed URL without the runner token,
  then calls `complete` with its metadata; a job that cannot run is reported with `fail` (the API returns it to the
  queue once, then fails it with a refund due);
- survives API restarts: polling backs off up to 60 s, failed heartbeats are retried, delivery is retried with
  heartbeats in between for up to 15 minutes, and run.json stays on disk either way.

It stops itself (exit code 1) when the API refuses its token or when its own settings are broken (for example an
LLM model without a price), after handing the current job back, so a broken runner cannot burn through the queue.

Logs: one line per event on stdout (`job run_…: claimed`, `round 3/10`, `complete and published`). The engine's
own logs are in each attempt's `child.log`. Delete old attempt folders by hand when the disk fills up.

A runner killed mid-job loses nothing. Its run notices that nobody reads its progress and stops at the end of the round, the
API takes the job back after 90 s without a heartbeat, and the next runner plays it from the start. A job that fails twice is
marked failed with a refund due. A stopped runner (Ctrl+C, `docker stop`) hands the job back at once.

A job can also be a Dry Run (`docs/API.md`): a crowd of synthetic users tries a contract. The runner plays it in the same way and delivers `dryrun.json`, which stays
private to the wallet that asked. A deployed address needs `RH_RPC_URL`, because it plays on a fork. Creation bytecode plays on a plain chain. To play one by hand:

```
cd engine
uv run python -m hyvo dryrun examples/dryrun/sample-vault.json --offline
```

A job can also build a Wallet Clone. It needs `BLOCKSCOUT_API_KEY` in the runner's `.env` (`docs/OPEN_ITEMS.md` item 24), and `CLONES_ENABLED=1` on the Worker opens `/clone`. The job's folder is deleted when it ends, because it names a wallet.

A rewind needs `RH_RPC_URL`, because it forks at an old block. Public nodes serve old state on and off (item 25), so a rewind can fail and be refunded. By hand:

```
cd engine
RH_RPC_URL=https://robinhood.drpc.org uv run python -m hyvo rewind <pool> <block> "The rumor came two hours earlier." --round 3 --hours 6 --offline
```

## The daily run

`python -m hyvo daily` plays one public run a day, by default from the scenarios in `engine/examples/scenarios`, in turn, on a
fork when `RH_RPC_URL` is set. It needs `HYVO_API_URL`, `RUNNER_TOKEN` and `LLM_API_KEY`. Options: `--once` (try today's run
now, exit 0 when it is published), `--at HH:MM` (UTC, default 01:00), `--scenarios DIR`, `--agents`, `--rounds`, `--featured`.

Nobody reads a daily run before its hash goes on-chain for good, so it goes out only if a language model played it to the end,
the last read of its posts finished, and the copy check passes. Otherwise it is recorded and stays private.

`<runs dir>/daily/<YYYY-MM-DD>.json` says what happened that day (`status`: `published`, `played`, `refused` or `failed`, with
`detail` and `history`), and each attempt's output is in `<runs dir>/daily/<day>/attempt-<n>/`. A day gets 3 attempts, an hour
apart. A restart changes nothing: an attempt counts before it starts, a published day does nothing, and a run that was played
but not delivered is delivered rather than played again.

A 50 x 10 run costs about 3,000 of the 10,000 free Workers AI neurons, shared with anything else on the account, plus one oracle
commit of about 94,000 gas from the attester.

### Seed packs, post threads and Autopsy

`--seed-packs` turns the Narrative Engine on (SPEC §10). The graph in `<runs dir>/narrative/graph.sqlite` is refreshed every hour from Robinhood Chain's
pools and public news feeds, and keeps 14 days. Each day's scenario comes from its pack, in `<runs dir>/narrative/packs/<day>/` (`scenario.md`, and `pack.json`
for what went into it). On a thin day, or if the Narrative Engine breaks, the day's run uses an example scenario. **It is off by default:** a pack names a
real token, and whether public runs should do that unattended is the founder's decision (docs/OPEN_ITEMS.md item 23).

A pack is a template filled with public numbers, so a model cannot invent anything in it. The report model reads every line before it plays, and what it
flags stays out. If it refuses the token, the next one is tried. A pack nobody read is never played. A token must be recent (14 days), have at least $10,000
of liquidity and $1,000 of daily volume, and a fully diluted value under $50 million, which keeps stablecoins and the largest tokens out.

```
python -m hyvo seedpack --no-read          # look at today's pack, with no model and no allowance; in narrative-unread/, which no daily run uses
python -m hyvo seedpack                    # build it for real: one model call
python -m hyvo cast <run.json>             # a post thread from any run, written next to it
python -m hyvo autopsy --no-read           # today's Autopsy scenario, if a tracked token moved far enough
python -m hyvo daily --seed-packs          # the daily loop with all of it
```

Every published daily run gets `thread.md` next to its `run.json`: a short thread for X and Farcaster, from the run's own report. **Posting it is by hand:** nothing
here holds an account on either. `HYVO_SITE_URL` sets the link in it.

`--autopsy` adds a smaller run (25 x 8, about 1,000 neurons) once the day's run is out, when a token the graph already knew moved 50% or more in 24 hours. Its crowd
learns only what was public before the move, and the seed text says that this does not explain the real price. A token gets one Autopsy a week.

Casts need `NEYNAR_API_KEY` (docs/OPEN_ITEMS.md item 8). They only feed the graph's topic counts: no cast's words or author reach a scenario.

## Always on, with Docker

`deploy/runner/` holds a Compose project with two services from one image: `daily` and `runner`. **It has not been built yet:**
no machine with Docker has been set up. `engine/tests/test_deploy_files.py` checks that the files agree with the code, and the first
build on a real machine is the real test.

```
cp .env.example deploy/runner/.env      # keep the engine part, fill it in, with RH_RPC_URL=https://robinhood.drpc.org
docker compose -f deploy/runner/compose.yaml up -d --build daily     # add `runner` once payments are open
docker compose -f deploy/runner/compose.yaml ps                      # health
docker compose -f deploy/runner/compose.yaml logs -f daily
```

- Anvil is in the image, because each job starts its own (SPEC §3). The image leaves out torch and the GPU libraries it brings on
  Linux, about 4 GB of wheels: Hyvo replaces the only part of OASIS that needs them.
- `restart: unless-stopped` covers a loop that dies. A loop that hangs stops touching its health file, and the health check then
  ends the container, so the restart policy covers that too. Docker alone would only report it as unhealthy.
- Logs rotate at 10 MB, five files per service. State is in the `data` volume: nothing is lost when the image is replaced.
- `hyvo health <file> --max-age 300` is the check itself, and can be run by hand on any machine.

## End-to-end test on a local chain

```
pnpm --filter @hyvo/api e2e
```

It starts anvil (chain 4663), deploys TestStablecoin (as USDG), HyvoOracle and PaymentRouter, runs the Worker with
its own throwaway state under `apps/api/.wrangler/e2e-<time>/`, signs a test user in with SIWE, quotes a 10 × 3 run,
approves and pays through PaymentRouter, lets `python -m hyvo runner --once --offline` play it, waits for the
attester's commit, verifies it like a third party (hashes against `getCommit` read from the chain, treasury paid,
router empty) and finally opens `/oracle?run=<id>` of the web app in Chromium and waits for the browser's own
verification. A screenshot of that page is saved next to the state. `--no-web` skips the browser step, `--keep`
leaves everything running. All keys are anvil's public test keys; nothing touches a real network.

## Tests

| Package | Command |
|---|---|
| everything JS | `pnpm -r test` (schema, API in the Workers runtime, web unit tests) |
| web (desktop + phone, stubbed API, chain and wallet) | `cd apps/web && npx playwright test` |
| engine | `cd engine && uv run python -m pytest -q` |
| contracts | `cd chain && forge test` (coverage: `forge coverage`; static analysis: Slither, see `chain/README.md`) |
| the whole Phase 3 flow | `pnpm --filter @hyvo/api e2e` |

The repo's `.env` points at production, so the engine's tests set `HYVO_NO_DOTENV=1` and do not read it
(`engine/tests/conftest.py`). Without the switch, a test of the runner's missing settings would start a real runner
against the live queue.

## Keys and rotation

| Secret | Where | Rotate |
|---|---|---|
| `RUNNER_TOKEN` | Worker secret and the runner's environment | `wrangler secret put RUNNER_TOKEN`, then restart the runner with the new value. Jobs in flight fail their next call with 401: the runner stops, the API returns the job to the queue after 90 s without heartbeats, and the restarted runner picks it up. |
| `LLM_TOKEN` | Worker secret, and `LLM_API_KEY` in the runner's `.env` | `wrangler secret put LLM_TOKEN`, then change `LLM_API_KEY` and restart the runner. Opens the LLM endpoint only. |
| `ARTIFACT_SIGNING_KEY` | Worker secret | `wrangler secret put ARTIFACT_SIGNING_KEY`. Signed artifact and upload links in flight (≤ 15 min) stop working; clients ask for new ones. |
| `ATTESTER_PRIVATE_KEY` | Worker secret only, never on the runner | 1. Make a new key and fund its address with a little ETH on Robinhood Chain. 2. From the owner Safe call `HyvoOracle.setAttester(<new address>)`. 3. `wrangler secret put ATTESTER_PRIVATE_KEY`. Commits sent between steps 2 and 3 fail with `NotAttester` and are retried by the cron until they go through. Then empty the old key's ETH. |
| Session tokens | D1 (SHA-256 only) | `DELETE FROM sessions` signs everyone out. |

Watch the attester's ETH balance: each commit costs gas. A commit that fails for lack of gas shows as `failed` with the
error in the admin page and is retried after 2, 4, 8... minutes, at most one hour apart, so topping up the balance is
enough. Only a chain that holds another hash for the run ends the retries; that should never happen, so treat it as an
incident.

## Refunds

Refunds are owed for failed paid runs (`run_failed`, the quoted amount), payments that cannot pay their order
(`payment_unmatched`, the full amount: unknown order, second payment, wrong token, underpaid, more than 5 minutes after
the quote expired) and the excess of an overpayment (`overpaid`). The API records them; it never moves funds.

1. Open `/admin` with a founder wallet. "Refunds due" lists amount, recipient (the payer), reason and run. A token the
   API does not know is shown in base units with its address.
2. From the treasury, send exactly that amount of that token to that address.
3. Paste the transaction hash (and a note) into the refund's form and record it as sent. The run page then says
   the payment was refunded.

A failed holder free run needs nothing: its credit goes back to the wallet's month automatically. Partial runs
(stopped at their budget or timeout) are not refunded automatically; review them in the admin page.

## Daily operations

- `/admin`: queue (pause or resume), LLM spend today against `DAILY_SPEND_CAP_USD`, fees, failures, refunds due,
  oracle commits pending or failed.
- Set a daily cap on every paid LLM provider's dashboard too (money rule 2). Workers AI's free allocation is its own cap.
- Pausing the queue lets running jobs finish and hands out nothing new.

## Windows notes

- Run the engine with `PYTHONUTF8=1` for UTF-8 console output.
- Application Control can block uv's `.exe` launchers (`pytest.exe`, `hyvo.exe`): use `uv run python -m pytest` and
  `uv run python -m hyvo`.
- On some machines Windows Application Control also blocks `engine/.venv/Scripts/python.exe`, so `uv run` fails with os error 4551. uv's own CPython still runs; a small `sitecustomize.py` on `PYTHONPATH` that calls `site.addsitedir` on the venv's `Lib/site-packages` gives it the engine's packages.
- Some ISPs block `*.robinhood.com`; forks use `RH_RPC_URL=https://robinhood.drpc.org`
  (docs/OPEN_ITEMS.md items 3 and 14). The web app's RPC list falls back to dRPC for the same reason.
- A hard-killed engine no longer leaves anvil running (job object); leftover data dirs are swept on the next run.

## Going live

Nothing here runs without the founder's approval (docs/OPEN_ITEMS.md items 12, 13, 21).

### 1. Cloudflare, on the free plans

Done on 2026-11-04 (docs/OPEN_ITEMS.md item 13): web <https://hyvo.pages.dev>, API <https://hyvo-api.artallm.workers.dev>. Run
the same command to deploy new code.

```
pnpm --filter @hyvo/api deploy:cloudflare          # names the account, builds the bundle, changes nothing
pnpm --filter @hyvo/api deploy:cloudflare --yes    # does it
```

Check that the account it names is the one Hyvo should live on. With `--yes` it
creates D1 database `hyvo`, KV namespace `hyvo-artifacts` and Pages project `hyvo` if they are missing, writes their ids to
`apps/api/wrangler.jsonc` (commit that), applies the migrations, generates `RUNNER_TOKEN`, `LLM_TOKEN` and
`ARTIFACT_SIGNING_KEY` once and keeps them in the repo's `.env` (gitignored), deploys Worker `hyvo-api` and the web app,
writes the runner's settings to `.env`, publishes `fixtures/showcase-run.json` if no run is featured yet, and checks the
result from outside: the API, the web app, and the featured run's hash recomputed from its published bytes. It can run again:
what exists is kept, and it touches nothing else on the account. Once a run is featured a deploy publishes nothing, because
publishing commits a run on-chain.

The deployed Worker takes `apps/api/production.vars.json` on top of `wrangler.jsonc`, plus `WEB_ORIGIN` and `SIWE_DOMAIN`.
A bare `wrangler deploy` would put the local values back, so always deploy with the script.

The free plan allows 5 cron triggers per account. If the deploy fails on that, other Workers on the account hold them.

**Then check the real CPU use.** The design for the 10 ms limit rests on measurements on a laptop (docs/OPEN_ITEMS.md item
21), not on Cloudflare. In `apps/api`, run `npx wrangler tail --format json` while a run is published and pages are opened: an
`outcome` of `exceededCpu` means a request hit the limit, and `cpuTime` is in each event. The Worker's Metrics page in the
dashboard charts CPU time. First measurements: docs/OPEN_ITEMS.md item 21.

### 2. The runner

On a machine that stays on, use Docker ("Always on, with Docker" above). Elsewhere:
`cd engine && uv run python -m hyvo runner`. It reads its settings from `.env`. Add `RH_RPC_URL=https://robinhood.drpc.org`
there so that runs fork Robinhood Chain (docs/OPEN_ITEMS.md item 3); without it they play on a plain local chain with the
same chain id.

### 3. Contracts and payments

Until this step the site shows the gallery and replays, and says that paid runs are not open yet. The oracle and payments
are separate switches, so runs can be committed on-chain before payments open.

**Deploy.** `chain/.env` (gitignored) holds `DEPLOYER_ADDRESS`, `DEPLOYER_PRIVATE_KEY` and `ATTESTER_ADDRESS`. The attester's
key goes straight into the Worker (`npx wrangler secret put ATTESTER_PRIVATE_KEY` in `apps/api`) and nowhere else. With 0.002
ETH in the deployer wallet on Robinhood Chain (the deployment itself costs far less; the rest is gas for the attester, about
94,000 per commit):

```
cd chain
sh script/deploy-hyvo.sh https://robinhood.drpc.org
```

It deploys both contracts with that wallet as owner and treasury, checks what the chain says, gives the attester gas, and
writes `chain/deployments/4663.json` (commit it). The RPC can answer "already known" or "nonce too low" when `forge` sends a
transaction again that already went through, so trust the script's checks of the chain, not that message. Then verify the
sources on Sourcify, which Blockscout shows as "verified (exact match)". Blockscout's own API sits behind a browser challenge
and refuses `forge`:

```
forge verify-contract <oracle> src/HyvoOracle.sol:HyvoOracle --chain-id 4663 --verifier sourcify --watch
forge verify-contract <router> src/PaymentRouter.sol:PaymentRouter --chain-id 4663 --verifier sourcify --watch
```

**Turn the oracle on.** Add `ORACLE_ADDRESS` and `RPC_URLS` to `apps/api/production.vars.json` and deploy
(`pnpm --filter @hyvo/api deploy:cloudflare --yes`; the web app pins the oracle from the deployment file). Publishing a run
again with `hyvo publish` now commits it, and `/oracle` verifies it in a browser. An `RPC_URLS` that holds a key goes in as a
Wrangler secret instead. The first real commit took 87 ms of CPU in the Worker and the cron that confirmed it 30 ms, both
past the free plan's 10 ms and both tolerated (`ok`). There is one such pair per published run: watch for `exceededCpu` with
`npx wrangler tail --format json` when many go out in a day.

**Move ownership and the treasury to the founder's wallet.** The deployer wallet sends three transactions:

```
cast send <router> "setTreasury(address)" <founder> --private-key $DEPLOYER_PRIVATE_KEY --rpc-url <rpc>
cast send <router> "transferOwnership(address)" <founder> --private-key $DEPLOYER_PRIVATE_KEY --rpc-url <rpc>
cast send <oracle> "transferOwnership(address)" <founder> --private-key $DEPLOYER_PRIVATE_KEY --rpc-url <rpc>
```

Nothing changes hands until the founder's wallet calls `acceptOwnership()` on each contract, on the Write tab of the verified
contract on Blockscout, or from a Safe later on. Send what is left in the deployer wallet back, and take `TREASURY_ADDRESS`
in the next step from the chain.

**Open payments.** This needs the public source (docs/OPEN_ITEMS.md item 1) and the founder's answer on item 21. Add
`PAYMENT_ROUTER_ADDRESS`, `PAYMENT_ROUTER_DEPLOY_BLOCK`, `TREASURY_ADDRESS` and `ADMIN_ADDRESSES` to `production.vars.json` and
deploy, start the runner, play one small paid run end to end, and verify it on `/oracle`.

### 4. The token launch, last

After the launch on Pons: `HYVO_TOKEN_ADDRESS` and `HOLDER_MIN` (> 0 turns holder benefits on) in
`production.vars.json`, deploy again, and a Safe transaction `PaymentRouter.setTokenAllowed(<token>, true)` if the token
should be accepted as payment (quotes are in USDG until a token price source exists, docs/OPEN_ITEMS.md item 17).

## What the free plans allow

Sources: developers.cloudflare.com, read 2026-11-04. Every number is per Cloudflare account, shared with anything else
deployed there.

| Service | Allowance | Hyvo's use |
|---|---|---|
| Workers | 100,000 requests a day (00:00 UTC, then `Error 1027`); 10 ms of CPU per request and per cron run (`Error 1102` when consistently over); 50 subrequests per invocation, 1,000 to Cloudflare services; 5 cron triggers | one cron a minute (1,440 a day); a runner polling every 15 s (5,760 a day) |
| Workers AI | 10,000 neurons a day, documented to reset at 00:00 UTC (but see below); past that, calls fail | 2,200 to 2,800 neurons for a 50 × 10 run |
| D1 | 5 million rows read and 100,000 written a day (00:00 UTC, then queries fail); 500 MB per database; 50 queries per invocation; 10 databases | small rows; the run.json files are not here |
| KV | 100,000 reads and 1,000 writes a day; 1 GB; 25 MiB per value | one write per published run, one read each time a run.json is opened |
| Pages | 20,000 files, 25 MiB per file, 100 projects | one project |

**Capacity.** `DAILY_SPEND_CAP_USD` is $0.10, what 9,000 neurons cost at list price. Each run reserves its budget ($0.066
for 50 × 10) until it publishes, which makes about two runs of 50 × 10 a day. The largest run is 840 agent-rounds, for
example 80 × 10. A bigger crowd needs a paid LLM key: set `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL_NAME` in `.env`, and
raise the cost vars and the cap in `production.vars.json`.

**The reset is not what the documentation says.** The allowance ran out at about 23:40 UTC on 2026-11-04 and calls were refused, with Workers AI's own error `4006`, until about 19:22 UTC the next day: nearly 20 hours, and 19 past 00:00 UTC. Roughly 13,000 neurons had gone through on 2026-11-04 before that first refusal. So do not plan a run around 00:00 UTC: try a one-word call first. Anything else on the account draws on the same allowance, and only the dashboard shows that use (AI, Workers AI).

**When the neurons run out.** The cap normally stops the queue first (`/admin` shows spend, `X-Hyvo-Queue: spend_cap`), but
it does not see what anything else on the account spends. Past the allocation the LLM endpoint answers `429 llm_quota`. A
report call that fails falls back to the template report. A round whose decision calls all fail ends the run: the job
goes back to the queue once and then fails for good, with a refund due for a paid job and the credit returned for a free
one. Each failed attempt keeps its reservation, so the cap stops further jobs until 00:00 UTC.

**Replacing the showcase run.** In `engine/`, `uv run python -m hyvo publish ../fixtures/showcase-run.json --featured` makes
the newest one the home page's run and, with the oracle on, commits it on-chain, which cannot be undone. The old one stays in
the gallery unless its row in D1 is changed by hand (`listed = 0`); a run taken out that way is not committed if it is published
again.
