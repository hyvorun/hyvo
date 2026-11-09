# Open items

Facts about external systems that Hyvo depends on, and the decisions made about them. Nothing here is invented:
every value has a source, or is marked `PLACEHOLDER`. Research began on 2026-11-02.

Status: **verified** (checked against an official source or on-chain) · **likely** · **unknown** · **decision**
(founder must choose) · **resolved**.

| # | Item | Status | Value used in config |
|---|---|---|---|
| 1 | MiroFish license | resolved | the whole repository is `AGPL-3.0-or-later` |
| 2 | Extending MiroFish's action space | resolved | option (c), see `MIROFISH_NOTES.md` §9 |
| 3 | Robinhood Chain RPC, limits, anvil fork | verified | `RH_RPC_URL=https://robinhood.drpc.org` (runner) |
| 4 | USDG address | verified | `USDG_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| 5 | Pons pool type | verified | Stage 1 uses the Hyvo V2-style test pair |
| 6 | Zep Cloud free tier | verified | `ZEP_API_KEY=` (not needed in Stage 1) |
| 7 | LLM free tiers and prices | verified / likely | `LLM_*=` empty → offline model |
| 8 | Farcaster data API | verified | Stage 3 only |
| 9 | `hyvo.run`, X handle | attached / decided | site at `hyvo.run`, API at `api.hyvo.run` (`apps/api/domains.json`); X `@Hyvorun` |
| 10 | Report agent vs spec §6.7 | decision | Hyvo report agent modeled on ReportAgent |
| 11 | LLM for real-model runs | resolved | Workers AI through the Worker; no key |
| 12 | Mainnet deploy: owner, attester, treasury | deployed | `chain/deployments/4663.json`; owner and treasury still to move to the founder's wallet |
| 13 | Cloudflare deploys | resolved | live on the free plans since 2026-11-04 |
| 14 | Some ISPs block `*.robinhood.com` | verified | RPC fallbacks everywhere |
| 15 | Payment finality on Robinhood Chain | decision | `PAYMENT_CONFIRMATIONS=20` (about 2 s) |
| 16 | Historical state for the 24 h holder snapshot | likely | fail closed; the Worker's RPC must keep 24 h of state |
| 17 | Hyvo token as a payment token | decision | quotes in USDG only |
| 18 | Price parameters | decision | ×2.5, floor $1, step $1; holders 20% off the listed price ($0.80); on Workers AI $0.00005 per agent-round, $0.008 report (measured) |
| 19 | Refunds for partial runs | decision | not automatic; reviewed in `/admin` |
| 20 | Mobile wallets without an injected provider | decision | injected wallets only (no WalletConnect) |
| 21 | Cloudflare Workers plan | resolved | Workers Free; one trade-off to confirm (SPEC §8.4) |
| 22 | Phases 4 to 7 before the token launch, on free plans | decision taken | what needs money or an always-on machine waits, see below |
| 23 | Narrative Engine sources; real token names in public runs | verified / decision | GeckoTerminal and RSS, keyless; `--seed-packs` off by default |
| 24 | A wallet's history for Wallet Clone | verified / decision | `BLOCKSCOUT_API_KEY=` empty: clones are off until the founder makes a free key |
| 25 | How far back Rewind can fork | verified | a few days dependably on dRPC's free tier, further on and off; an archive RPC for more |
| 26 | Unused prepaid balance | decision | no self-serve refund; by hand from `/admin` |
| 27 | Publishing `@hyvo/sdk` to npm | decision | not published yet |
| 28 | Hyvo Stocks: where each fact comes from | verified / decision | on-chain StockFactory record + Chainlink feeds; Robinhood's API and docs not used |
| 29 | Pons launches for Hyvo Launches: sources and limits | verified / decision | read in the visitor's browser; endpoints in `packages/launches/src/endpoints.ts` |
| 30 | Hyvo Check: addresses and limits | verified | factories, hook and PoolManager read on-chain on every check; top holders from Blockscout through Hyvo's API (its own key); credit cost per request open |

---

## 1. MiroFish license — resolved

- MiroFish is **AGPL-3.0** (`engine/mirofish/LICENSE`, `backend/pyproject.toml`). OASIS (camel-oasis) and camel-ai are
  Apache-2.0.
- The engine adapts MiroFish code (with attribution comments) and is declared `AGPL-3.0-or-later`
  (`engine/pyproject.toml`). AGPL §13: if users interact with a modified version over a network, its source must be
  offered to them. Hyvo users interact with the API/web, which serve engine output; treating the engine as covered is
  the safe reading (not legal advice).
- **Resolved:** the whole repository is public under `AGPL-3.0-or-later` ([`LICENSE`](../LICENSE)), and the site footer
  links the source. `chain/`, `apps/` and `packages/` contain no MiroFish code, so a more permissive license for
  `packages/sdk` and `packages/schema` stays possible later.

## 2. Extending MiroFish's action space — resolved

Hyvo's own round loop uses OASIS as the social substrate, makes batched decisions with its own metered LLM client,
executes social actions through OASIS action methods and market actions through web3.py on the fork. Full reasoning
and evidence: [`MIROFISH_NOTES.md`](MIROFISH_NOTES.md) §9 and the appendices in `docs/mirofish/`.

## 3. Robinhood Chain RPC, rate limits, anvil fork — verified

- Chain ID **4663** is Robinhood Chain **mainnet** (Arbitrum Orbit L2 on Ethereum, ETH gas, live since 2026-07-01).
  Testnet is **46630**. Block time ≈ 0.1 s; head ≈ 104.35M on 2026-11-02.
  Sources: <https://docs.robinhood.com/chain/connecting/>, ethereum-lists `eip155-4663.json` / `eip155-46630.json`.
- Official RPC `https://rpc.mainnet.chain.robinhood.com` (testnet `https://rpc.testnet.chain.robinhood.com`). No
  published numeric limit; the ToS says it is rate-limited and not for production. Robinhood recommends Alchemy
  (`https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`). Explorer: <https://robinhoodchain.blockscout.com>.
- **Runner RPC:** `https://robinhood.drpc.org` (keyless free tier: 210M CU / 30 days, 120k CU/min per IP, 2 s timeout,
  batch ≤ 3, `eth_getLogs` ≤ ~100 blocks, historical state a few days back dependably and further on and off, item 25). PublicNode refuses state older than ~100
  blocks, so it cannot back a fork. Source: <https://drpc.org/docs/howitworks/ratelimiting>.
- **anvil fork works:** `anvil --fork-url https://robinhood.drpc.org --chain-id 4663 --no-storage-caching` was ready in
  1.1 s; a real Uniswap V2 swap on the fork succeeded. anvil 1.7.1 **crashed in 1 of 3 runs** on a transient dRPC
  error, so the fork manager supervises anvil and retries; a second archive-capable RPC (Alchemy key) would help.
  Arbitrum precompiles (`ArbSys` 0x64) revert on the fork; the Stage 1 test pair does not use them.
- Config: `RH_RPC_URL=https://robinhood.drpc.org`, `RH_RPC_URL_FALLBACK=PLACEHOLDER` (Alchemy key).
  Empty `RH_RPC_URL` → plain anvil with chain ID 4663 and no fork (tests, offline).

## 4. USDG address — verified

- Mainnet **`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`** (EIP-1967 proxy), name "Global Dollar", symbol USDG,
  **6 decimals**. Testnet `0x7E955252E15c84f5768B83c41a71F9eba181802F` (6 decimals).
  Sources: <https://docs.paxos.com/guides/stablecoin/usdg/mainnet>, <https://docs.robinhood.com/chain/contracts/>, on-chain reads.
- USDG can freeze addresses: `transferFrom` from or to a frozen address reverts. `PaymentRouter.pay` then reverts and no
  order is marked paid, which is the correct behavior.

## 5. Pons pool type — verified

- App <https://www.ponsfamily.com/launchpad>, docs <https://docs.ponsfamily.com/>. No public API; index on-chain events.
- **v1:** no bonding curve; token + Uniswap **V3** 1% WETH pool created in one tx, liquidity locked, fixed 1e9 supply.
  Fee split creator 70 / protocol 30 (legacy factory 90/10). Factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`.
- **v2:** constant-product bonding curve with a virtual quote reserve, then graduation to a Uniswap **V4** full-range
  position (locked) with the Pons "Meme hook" charging a 1% fee; protocol takes 30%; optional creator tax up to 10%;
  a snipe tax decays from 99% to 0 over 5 s on buys. Factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, hook
  `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`. On 2026-11-09 the factory's `snipeTaxSeconds()` read 3: the owner sets it,
  and each curve keeps the value it launched with (item 28).
- Spec §12.5 ("creator gets 0.7% of volume") holds for v1, and for v2 with buybacks off and no creator tax.
- **Impact:** Stage 1 keeps the V2-style test pair (`feeBps` can be set to 100 to mimic a 1% fee). Simulating real Pons
  tokens later needs V3 and V4-plus-hook execution on the fork.
- Uniswap V2/V3/V4 are officially deployed on Robinhood Chain (V2 router `0x89e5db8b5aa49aa85ac63f691524311aeb649eba`,
  WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). Source: <https://developers.uniswap.org/docs/protocols/v2/deployments>.

## 6. Zep Cloud — verified

- Free: 10,000 credits/month (1 credit per 350 bytes of episode), no rollover. Flex: $125/month for 50k credits.
  Source: <https://www.getzep.com/pricing>. Zep Community Edition is deprecated; the self-hosted alternative is Graphiti
  (Apache-2.0) with Neo4j (no Windows-native embedded backend).
- Stage 1 does not use Zep. Stage 3 (rolling narrative graph) likely exceeds the free tier; decide at Gate B.
- **Decided for now (2026-11-06):** the rolling graph is a local SQLite file (`engine/hyvo/narrative/graph.py`): tokens and topics, the signals that mention them,
  and which appear together, pruned after 14 days. This deviates from SPEC §10, which names MiroFish's graph building on Zep. It needs no account and no money, and
  the seed pack does not need more from it. Moving to Zep or Graphiti later only touches that file.

## 7. LLM providers — verified / likely

- **DeepSeek** (`https://api.deepseek.com`): current model id **`deepseek-flash`** (V4.1 Flash). Per 1M tokens: input
  cache miss $0.15 off-peak / $0.30 peak, output $0.60 / $1.20; peak 01-04 and 06-10 UTC Mon-Fri. JSON output and tools
  supported. Thinking mode is on by default (disable with `extra_body={"thinking": {"type": "disabled"}}`). The spec's
  "$0.14/$0.28" is outdated; a decision now costs ≈ $0.0003-0.0006. Source: <https://api-docs.deepseek.com/quick_start/pricing>.
- **Gemini** OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai/`; free tier exists for
  several Flash models, but per-model RPM/RPD are only visible after login (unknown); free-tier data is used by Google.
- **OpenRouter** `https://openrouter.ai/api/v1`: `:free` models at 20 RPM and 50 requests/day (1,000/day after buying
  ≥ 10 credits). **Groq** free: 8K TPM (too small for 50×10). **Cerebras**: no ongoing free tier.
- Prices in `engine/hyvo/llm/pricing.py` must be re-checked before setting quotes (spec §12.4).

## 8. Farcaster data API — verified (Stage 3)

Neynar free plan: 10M credits/month, 600 RPM per endpoint. Self-hosting Snapchain needs 16 GB RAM and 2 TB disk (not a
laptop job). Source: <https://docs.neynar.com/reference/what-are-the-rate-limits-on-neynar-apis>.

`engine/hyvo/narrative/farcaster.py` uses `GET https://api.neynar.com/v2/farcaster/cast/search/` with the `x-api-key` header (read from
<https://docs.neynar.com/reference/search-casts> on 2026-11-06). It has only been tested against that documented shape. **Founder:** it stays off until there is a
`NEYNAR_API_KEY`, which takes a Neynar account; the seed pack does fine without it.

## 9. Domain and X handle — decision taken

- The domain is `hyvo.run`, chosen on 2026-11-06. `hyvo.com`, `.xyz`, `.app`, `.ai` and `.fi` were taken, and `.trade`,
  `.finance` and `.market` were ruled out because they clash with "not a trading signal".
- Bought on 2026-11-09 at Dynadot, with Cloudflare's nameservers, in the same Cloudflare account as the rest of Hyvo.
- `apps/api/domains.json` names the domains and the deploy attaches them with `wrangler deploy --domain`: the site at
  `hyvo.run` (and `www.hyvo.run`, which sends visitors on) from the Worker `hyvo-web`, which serves the built site as
  static assets only, free and unlimited on the Workers Free plan; the API at `api.hyvo.run`. Wrangler cannot attach a
  domain to a Pages project, hence the Worker. The Pages project `hyvo` still serves `hyvo.pages.dev`, whose page sends
  visitors to `hyvo.run` with the path kept, and the API's `*.workers.dev` address keeps answering. `WEB_ORIGIN` and
  `SIWE_DOMAIN` list both addresses of the site, the domain first.
- The X account is `@Hyvorun` (<https://x.com/Hyvorun>), made on 2026-11-09. The header, the footer and `/trust` link it
  (`apps/web/src/lib/official.ts`), so a lookalike site or account is easier to tell apart.

## 10. Report agent vs spec §6.7 — decision

Spec says "uses MiroFish's ReportAgent". As shipped it needs Zep, makes ~19-51 uncounted LLM calls, writes Markdown
without the structured fields `run.json` needs, and frames output as a "future prediction". Hyvo ships a report agent
**modeled on** ReportAgent (same plan/evidence discipline and anti-fabrication rules, 1-3 calls, structured fields,
banned-phrase guard, fixed disclaimer). **Founder:** confirm this deviation. A long-form ReportAgent-style "deep report"
can be added later as a paid extra.

## 11. LLM for real-model runs — resolved

Real-model runs use Cloudflare Workers AI through the Worker's own endpoint (`POST /internal/llm/v1/chat/completions`):
no provider key, and its free allocation of 10,000 neurons a day cannot cost money. Pricing page read 2026-11-04:
$0.011 per 1,000 neurons, so USD at list price converts directly.

Models, chosen from a 10 × 3 trial on the real endpoint on 2026-11-04:

| Model | Neurons (10 × 3) | Result |
|---|---|---|
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | about 168 | posts and trades in 29 s: **agents** |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | about 900 | good, too expensive per decision: **report only** |
| `@cf/ibm-granite/granite-4.0-h-micro` | about 46 | passive |
| `@cf/google/gemma-4-26b-a4b-it` | about 599 | inactive and slow |
| `@cf/zai-org/glm-4.7-flash` | not measured | timed out |
| `@cf/qwen/qwen3-30b-a3b-fp8` | not measured | spends its tokens on reasoning |

A real 50 × 10 run cost 2,200 to 2,800 neurons ($0.024 to $0.031 at list price) in 100 to 135 s
(`fixtures/showcase-run.json`). A cheap model has limits worth knowing: about 17% of its decisions carry a new post, a
few percent of its trades are invalid and become a hold, and it copies the posts it is shown, which the engine now
drops. Bigger crowds or better prose take a paid key, set in `.env` the same way (`.env.example`).

**Since 2026-11-09 runs play on DeepSeek V4 Flash through OpenRouter** (the founder's key, `OPENROUTER_API_KEY` in the repo's
`.env`; the deploy then writes the runner's `LLM_*` for it). The free allowance fitted about one 50 x 10 run a day. Each call sends
`reasoning.enabled=false` and `provider.max_price` equal to the price the engine budgets with ($0.15 input, $0.30 output per million),
so OpenRouter only routes to providers at or under it (a cap below every provider answers 404). A 10 x 8 run with its report: 64,612
input and 7,619 output tokens, $0.0120 budgeted, $0.0047 charged, 102 s; its posts are specific and its report coherent. The Worker's
`COST_PER_AGENT_ROUND_USD` is 0.00015 and `DAILY_SPEND_CAP_USD` 3 (`apps/api/production.vars.json`). Ask an agent still uses Workers AI.

## 12. Mainnet deployment — decision

`HyvoOracle` and `PaymentRouter` deploys need: the owner, the attester address (its key goes into a Wrangler secret
only), the treasury address, and a deployer with ETH on chain 4663.

Founder's decision of 2026-11-05: a new wallet made for this deploys the contracts and is at first both owner and
treasury. Ownership and the treasury then move to the wallet the founder launches the token with, and a Safe follows
later. Both contracts are `Ownable2Step`: the current owner calls `transferOwnership`, the new owner calls
`acceptOwnership`; `PaymentRouter.setTreasury` changes the treasury in one call. The wallet's key is in `chain/.env`
(gitignored), and paid runs stay closed until these moves are done. The founder's wallet address is still `PLACEHOLDER`.

Deployed on 2026-11-05, sources verified with an exact match on Sourcify, which Blockscout shows:

- HyvoOracle: `0x2FEDc123c38B069cf78e5915852A61022E347642`
- PaymentRouter: `0x9ca245cA96dE8BFC13Df4a233ba6E2EcEc9AC6d1`
- Deployer, owner and treasury for now: `0x6C1A66A1E887c3C0D0246557Dc6bC289F4365d2E`
- Attester: `0x42Ab65eAFDae27416Fa2515ADDFD144B2AE1C37B` (its key is only in the Worker)

The contract's first commit is the withdrawn first showcase, `run_01M6KHXB5HQP7WSBM6QKJATFMS`, hash `0xb9358f5c…`, in block
106580876. The deploy script published the showcase file on every deploy, and publishing started to commit on-chain, so the
first deploy with the oracle on committed a run that had been taken off the site for breaking the copy rules. Only hashes are
on-chain, and a commit cannot be removed. A deploy no longer publishes anything once a run is featured.

Its row was taken out of D1 the same day, so `/oracle` does not list or link to that run. The chain keeps the commit.

The deployment cost about 0.00003 ETH. One commit costs about 94,000 gas, 0.000004 ETH at the gas price of that day. The
attester started with 0.0008 ETH: keep an eye on it. The oracle is on in production; payments are off, because the Worker has
no `PAYMENT_ROUTER_ADDRESS`.

## 13. Cloudflare — resolved

Live since 2026-11-04 on Cloudflare's free plans, and on its own domain since 2026-11-09 (item 9): web
<https://hyvo.run>, API <https://api.hyvo.run>. Hyvo's resources: Workers `hyvo-api` and `hyvo-web`, Pages project `hyvo`
(for `hyvo.pages.dev`), D1 database `hyvo`, KV namespace `hyvo-artifacts`. In a non-interactive shell, `wrangler pages project create` can deploy the current folder as a
Worker named after the project instead of creating a Pages project, so the deploy script passes `--force`.

## 14. ISP blocks of `*.robinhood.com` — verified

Some ISPs rewrite DNS for every `*.robinhood.com` host (RPC and docs) and `docs.paxos.com` to a block page, even through
1.1.1.1. Consequences: the runner uses a third-party RPC (item 3), and the web app overrides viem's default `robinhood`
chain RPC (the first default is the official one) with a `fallback([...])` transport. Cloudflare Workers resolve normally.

## 15. Payment finality — decision

Robinhood Chain is an Arbitrum Orbit L2 with about 0.1 s blocks (item 3). A payment counts once its block has
`PAYMENT_CONFIRMATIONS` blocks on top (default 20, about 2 s). Deep reorganizations of the sequencer's chain are not
expected, but how this chain handles them is not documented (unknown). **Founder:** keep 20, or wait for L1
finality for large payments. The value is a Worker var, so it can change without a deploy of code.

## 16. Historical state for the holder snapshot — likely

Holder benefits need `balanceOf` at the block of 24 h ago (about 864,000 blocks back). dRPC's free tier serves that and far
more, on and off (item 25); PublicNode keeps under 100 blocks; Alchemy has archive state. The Worker finds
the block from timestamps and refuses benefits when either read fails, so a pruned RPC only switches benefits off.
**Founder:** use an archive-capable `RPC_URLS` entry once the token launches.

## 17. Hyvo token as a payment token — decision

`PaymentRouter` can allow the Hyvo token (SPEC 7.2), but pricing a run in the token needs a price source (the Pons
pool, a TWAP or a fixed rate), which does not exist before the launch. Until it does, every quote is in USDG and the
token gives holder benefits only. **Founder:** choose the price source after the launch.

## 18. Price parameters — decision

The price formula follows SPEC 8.3. `wrangler.jsonc` holds the per-decision cost of SPEC 12 rule 4 ($0.0003, DeepSeek-class
model) and $0.02 for the report: 50 × 10 is $1 with a $0.34 LLM budget, 500 × 20 is $8 with a $6.04 budget. On Workers AI
the measured cost is lower (`apps/api/production.vars.json`: $0.00005 and $0.008), so 50 × 10 still costs the $1 floor,
with a $0.066 budget. **Founder:** confirm floor and step. All values are Worker vars.

**Founder, 2026-11-09:** the holder discount (20%, `HOLDER_DISCOUNT_BPS`) comes off the listed price, floor included, so it is
real at every size: a $1 run costs a holder $0.80 (`runPriceUsd` in `packages/schema/src/pricing.ts`). Holders need at least
1,000,000 HYVO, now and 24 hours earlier (`HOLDER_MIN`, set by `token:go-live` at the launch).

## 19. Refunds for partial runs — decision

A run that hits its LLM budget or its timeout is published as `partial` and is not refunded automatically; failed runs
are. **Founder:** decide whether partial runs get a full, a partial or no refund (the admin page counts them).

## 20. Mobile wallets — decision

The web app connects injected wallets (browser extensions and wallet in-app browsers, EIP-6963). Mobile wallets
without one need WalletConnect, which needs a project id from WalletConnect Cloud (an account). **Founder:** decide
whether to add it.

## 21. Cloudflare Workers plan — resolved: free plans (one trade-off to confirm)

The founder chose on 2026-11-04: everything on Cloudflare, and no Workers Paid. Limits and capacity:
[`RUNBOOK.md`](RUNBOOK.md), "What the free plans allow". What the choice changed:

- **The Worker no longer parses or re-hashes runs (a deviation from SPEC §8.4).** Workers Free gives 10 ms of CPU per
  request and per cron run. Measured on Node 24, laptop: parse, zod, JCS and keccak of the 202 KB golden run cost 57 ms
  cold and 11 ms warm. So the runner verifies each run (hash, schema, rules, price replay) and reports its metadata, and
  the Worker checks only the SHA-256 of the bytes and that the metadata is the job. Every browser re-hashes what it opens.
  **The consequence:** whoever holds `RUNNER_TOKEN` could publish a run whose reported hash does not match its bytes, and
  the attester would commit that hash. Anyone who re-hashes sees the mismatch, but a commit cannot be replaced. The token
  lives only on the runner machine, so the trust boundary is that machine. `VERIFY_RUNS_IN_WORKER=1` restores the check
  on Workers Paid; no other code changes.
- **secp256k1 runs in WebAssembly** (`tiny-secp256k1`): SIWE recovery and attester signatures. In JavaScript the first
  signature costs about 50 ms of CPU; in WASM about 5 ms, compile and setup included (same laptop).
- **run.json files live in Workers KV, not R2.** R2 is not enabled on the account (Wrangler error 10042). KV is
  eventually consistent, up to about a minute elsewhere, so a run just published can answer `503 not_ready`.
- **Measured on Cloudflare** (`wrangler tail`, 2026-11-04, 139 invocations): no `exceededCpu` and no exceptions, with a
  median of 2 to 3 ms. About 1 in 8 went over 10 ms and still finished: sign-in 16 and 38 ms, publishing a 174 KB run 23
  and 24 ms, a cron run 6 to 13 ms, and first requests on a cold isolate up to 22 ms. "Each isolate has some built-in
  flexibility", the limits page says, without a number, and a Worker that consistently runs over is terminated. So this
  fits so far, at almost no traffic; it is not proven under load. A low-traffic Worker meets many cold isolates, so watch
  for `exceededCpu` as traffic grows (RUNBOOK, "Going live").

**Founder:** confirm the §8.4 trade-off. Workers Paid ($5/month minimum, read 2026-11-03) stays the way out if a limit
bites.

## 22. Phases 4 to 7 before the token launch — decision taken

Founder, 2026-11-06: the revenue gates are lifted and the token launches last, after Phase 7. Founder, 2026-11-09: paid runs stay off until the HYVO
token launches, and open with it. The API turns them on only when `PAYMENT_ROUTER_ADDRESS` is set in
`apps/api/wrangler.jsonc` (it is empty now); until then the paid products show "Opens with paid runs". Free plans stay the rule, and
spending anything needs the founder's approval. So some definitions of done in SPEC §14 cannot be met by writing code alone:

- **Phase 4, "publishes unattended for 7 days" on a small server.** This takes a machine that stays on for 7 days, and a server
  costs money. No machine with Docker has been set up yet, so `deploy/runner/` has never been built: its first build, and
  its `kill 1` restart of a hung loop, are untested until there is a machine. The Foundry release and its checksums were read
  from GitHub, and the Linux anvil's glibc need (2.35) from the binary itself.
- **Daily runs and the Narrative Engine** spend about 3,000 of the 10,000 free daily neurons per run.
- **Phase 7, crowds of 1,000+ agents.** One run of 1,000 x 10 is about 56,000 neurons, more than the free allowance of a day:
  it needs a paid LLM key to run with a real model. Until then such crowds run on the offline model only. Played on the offline model on 2026-11-06: 1,001 calls, 3.08 MB, every swap replaying. **Not measured:** whether a Worker on the free plan takes a 3 MB upload within its 10 ms of CPU, because only runs up to 174 KB have gone through one (item 21). A run that large also spends more than the daily cap allows, so production refuses it until the cap and the plan change.

## 23. Narrative Engine sources; real token names in public runs — verified / decision

Sources, all read for real on 2026-11-06:

- **GeckoTerminal** public API, `https://api.geckoterminal.com/api/v2/networks/robinhood`: `new_pools`, `trending_pools`, `pools?sort=h24_volume_usd_desc`,
  `pools/<address>/trades`. No key. CoinGecko's docs say keyless use is limited per IP and give no number for it; a page of its old guide says 30 calls a minute, and ten calls
  in a row did get `429` here. The engine makes a few calls an hour and waits once on a `429`. Pons pools show up as `pons-v2` and `pons-v2-dex`. Scanning the
  chain directly is not an option on the free RPC (`eth_getLogs` covers about 100 blocks, some 10 seconds, item 3).
- **DexScreener** also lists chain `robinhood` (`https://api.dexscreener.com/latest/dex/search`), and is not used yet.
- **News feeds** in `engine/hyvo/narrative/rss.py`: CoinDesk, Cointelegraph, Decrypt, Blockworks, The Block. Only headlines and links reach a run.
- **Robinhood's official list of stock tokens is unknown here:** an ISP block keeps `docs.robinhood.com` out of reach (item 14). So nothing claims that a token is an official
  stock token. Stock-like symbols such as NVDA or TTWO appear only as neutral market lines, with no address, and a fully diluted value over $50 million keeps a token
  from being the subject of a run.

**Founder, decide before `--seed-packs` goes on in production:** a seed pack is about a real token, with its real symbol, and its run goes out unread with its hash on-chain
for good. Agents will say harsh things about that token, as a crowd does. What guards this: every result carries the disclaimer; the scenario says it is a simulation on
a private test market; the report model reads the scenario and every post, and flags verdicts, price claims, fraud stated as fact, vulgarity and real people; a run whose read
did not finish does not go out. What it cannot fully guard: a model that misses something, on a permanent record, about a token someone holds. The alternative is a
fictional symbol with the same real market facts, which keeps the narrative and gives up the name. Until this is decided, the daily run uses the fictional example scenarios.

## 24. A wallet's history for Wallet Clone — verified / decision

A clone needs one wallet's swaps, with times and amounts. What was tried on 2026-11-06:

- **The RPC cannot do it.** On dRPC's free tier `eth_getLogs` works over 100 blocks and is refused at 1,000. At 9.8 blocks a second, 100 blocks are 10 seconds of chain.
- **The explorer's own host is closed to programs.** `robinhoodchain.blockscout.com/api/...` answers `403` with a bot challenge ("Just a moment..."). Hyvo does not try to get
  around it.
- **Etherscan's V2 list and Routescan** do not have chain 4663 (`api.etherscan.io/v2/chainlist`; Routescan answers "chain not supported").
- **Blockscout's keyed API is the one chosen.** <https://docs.blockscout.com/robinhood-api> names `https://api.blockscout.com/4663/api/v2/addresses/<address>/transactions?apikey=proapi_...`,
  with a key "required for all Blockscout API tiers, including free" from <https://dev.blockscout.com>. Free: 5 requests a second, 100K credits a day, $0.
  **Not verified without a key:** that page does not show the route for an address's token transfers. The engine uses `addresses/<address>/token-transfers?type=ERC-20`, the route
  and the response of Blockscout's standard API, read on another public Blockscout instance. Check it with the first real key.
- **Others, read but not used:** GoldRush (`api.covalenthq.com/v1/robinhood-mainnet/address/<address>/transactions_v3/`: 14-day trial, then from $10 a month), Zerion
  (`api.zerion.io/v1/wallets/<address>/transactions/`: free tier of 2K requests a day, chain slug not stated), Bitquery (history needs a paid add-on), Moralis (trial on request).
  A blog says Alchemy's Transfers API is live on the chain; Alchemy's own docs could not be read from here.

**Verified with the founder's key, 2026-11-09:** `tokens/<address>`, `tokens/<address>/holders`, `smart-contracts/<address>`,
`addresses/<address>/token-transfers?type=ERC-20` and `addresses/<address>/transactions` on `https://api.blockscout.com/4663/api/v2` all answer
`200` with the fields the code reads. The key is in the repo's `.env` (gitignored) as `BLOCKSCOUT_API_KEY` and, set by the deploy from there, a
secret of the API Worker. `CLONES_ENABLED` stays `0`: building a clone queues a job for a runner, which today is the founder's laptop, and a
clone only plays in paid runs, which open with the token (item 22).

## 25. How far back Rewind can fork — verified

Measured on 2026-11-06 at head 107.27M, at 9.81 blocks a second: `eth_call`, `eth_getStorageAt` and `eth_getCode` on dRPC's free tier answered at every depth tried, up to 100 days
back (block 22.5M), and USDG's `totalSupply` differed from block to block, so these are real old values. This replaces the "about 2.3 days" written on 2026-11-02. Old receipts are there
too (block 1,000,000).

**It comes and goes.** The same calls, minutes later, answered `Unknown state. First available state is 1` (code 27) at every depth, and in a later sample worked up to 3 days back and only in part at
30 days (`eth_call` 6 of 6, `eth_getStorageAt` 2 of 6, `eth_getBalance` and `eth_getCode` 0 of 6). So the requests are reaching different nodes, and dRPC promises nothing here. Reading the pool's past
waits out a burst and tries again. A fork at a block depends on the same state, so a rewind more than a few days back may fail; it is then tried once more, and refunded if it fails again. **For a
dependable Rewind, an archive RPC is needed** (Robinhood recommends Alchemy; item 3).

Pools that GeckoTerminal lists as `pons-v2-dex` have 32-byte ids, not contract addresses, so they cannot be read this way and Rewind refuses them.

Tried for real on 2026-11-06, read-only and on the offline model: a `pons-v2` pool at a block 18 hours back, 15 x 5. The path came from the chain (the pool rose 85% in the six hours after that block), the fork ran, and the run verified. The first attempt
failed when the fork stalled on the public node, and the second worked, so expect that from a free RPC.

Real Pons pools (`pons-v2`, factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`) answer `getReserves()` and `factory()`, and revert on `token0()` and `token1()`. Their first reserve was
the ETH side on the four pools read. So Rewind reads a pool's reserves at a block and at later blocks straight from the chain, and takes its token's name from GeckoTerminal. It plays on
Hyvo's V2 test pair seeded with those reserves, and says so (`kind: "v2-test"`), because Pons's own swap interface is not public here.

## 26. Unused prepaid balance — decision

A wallet's balance has no self-serve refund. Money that goes in stays there until it pays for runs, Dry Runs or questions; a failed run goes back to the balance. **Founder:** decide
whether to offer withdrawals, and say so where people top up. Nothing changes until payments open.

## 27. Publishing `@hyvo/sdk` to npm — decision

`packages/sdk` is built and tested in the repo. Publishing needs an npm account for the project; the package is `AGPL-3.0-or-later` like the rest of the repo unless item 1 is revisited.

## 28. Hyvo Stocks: where each fact comes from — verified / decision

Hyvo Stocks (`/stocks`, `packages/stocks`) brings the founder's StockSync project into Hyvo. StockSync read Robinhood's Stock Token API
(`api.robinhood.com/rhj`); Hyvo Stocks reads the chain instead, and Chainlink's feed directory for the feeds' addresses. Everything below was read
or measured on 2026-11-09 through `https://robinhood.drpc.org`, unless it says otherwise.

**The contracts (verified on-chain and on Sourcify).**

- **AccessControlsRegistry** `0xe10b6f6B275de231345c20D14Ab812db62151b00`, block 7662: the beacon of every stock token (`implementation()`), and the
  holder of every role, the pause switch and the blocklist. Source verified on Sourcify, exact match (`src/AccessControlsRegistry.sol`).
- **Stock implementation** `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`, block 7784: `src/Stock.sol`, MIT, Sourcify exact match. What the pages rely
  on, read in that source: `uid()`; `terms()` returns `https://robinhood.com/stocktoken/rhj`; `paused()` is the token's own pause or the registry's,
  and transfers, approvals, mints and burns revert while it is true; `oraclePaused()` is a flag the token itself does not use; `uiMultiplier()` switches
  to `newUIMultiplier()` once the block time reaches `effectiveAt()`; `updateMultiplier` refuses an effective time in the past. Its storage namespaces
  are named `robinhood.storage.*`.
- **StockFactory** `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046` (an ERC-1967 proxy; implementation `0xEe351E53BCe6AAF106428358838197C91e36EE0E`), block 7791.
  **Its source is not verified anywhere Hyvo looked.** Its functions were identified from its bytecode with the openchain signature database:
  `tokenAddress(bytes32)`, `deploy(bytes32,string,string)`, `beacon()`, `ACCESS_CONTROLLED_REGISTRY()`; its bytecode holds the revert string
  "StockFactory: stock already exists" and the role ids `TOKEN_DEPLOYER_ROLE` and `FACTORY_UPGRADER_ROLE` of `src/Roles.sol`; its event matches
  `keccak256("Deployed(bytes32,address,string,string)")`, with the uid indexed. Checked behavior: `beacon()` and `ACCESS_CONTROLLED_REGISTRY()` return the
  registry, `tokenAddress(uid)` returns each token for its own uid, and its 212 `Deployed` events match its nonce (213: one for its creation).
- **The deployer** `0x074377a78A9710A1D47244f89797718b4f491279` is an account with nonce 20; its first four CREATE addresses are the registry, the
  implementation, the factory's implementation and the factory.
- **How the factory was found:** from the NVDA address `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`, as StockSync recorded it from Robinhood's Stock Token
  API on 2026-09-14, through its EIP-1967 beacon slot (the registry), the registry's deployer on Sourcify, and that deployer's CREATE addresses. That one
  address was the starting point; Hyvo does not call the API.
- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11`: code hash `0xd5c15df6…0891`, the same 3,808 bytes as on Ethereum mainnet; present since block 1.

**The verdict.** A contract is "recorded" when the factory's `tokenAddress(uid())` returns that contract. A copy can take a token's ticker, name and
even its uid, but not the factory's record; the pages say so, and call anything else "not recorded", never a judgment of the contract. **Robinhood's
own docs do not name this factory:** their Token Contracts page loads its table from elsewhere, and none of the three addresses above appears on it
(checked 2026-11-09). So the pages say "the Stock Token factory" and show the evidence; they never claim to speak for Robinhood.

**The list and the history (`packages/stocks/src/snapshot.json`).** Built by `pnpm --filter @hyvo/stocks scan` from the chain alone, up to block
109,864,570 (2026-11-09 06:56 UTC): 212 tokens, 71 multiplier updates on 53 of them, 6 name changes, 3,985 RPC calls on dRPC's free tier in about ten
minutes. dRPC's free tier refuses `eth_getLogs` over long ranges (it refused 1,472 blocks here, "ranges over 10000 blocks are not supported on free
plan"), so the scan bisects instead: over the factory's nonce at past blocks to find each deployment, then over each token's `effectiveAt()`,
`newUIMultiplier()`, `name()` and `symbol()`, and reads the events only in the blocks found. That needs old state, which the free tier serves on and
off (item 25); the scan retries until a node has it. Check: every update's old multiplier equals the value in effect when it was sent (a unit test).
The list page reads the factory's nonce live and says how many tokens were deployed since; a newer token can still be looked up by address.

**Refreshed 2026-11-09, 11:09 UTC**, to block 110,011,251, with `RH_RPC_URL=https://robinhood.api.pocket.network pnpm --filter @hyvo/stocks scan`
(4,000 RPC calls, a few minutes). The same scan through dRPC first stopped with `"Unknown state. First available state is 1"` (code 27) on an
`eth_call` at an old block, 40 tries in a row; Pocket served the old state. The result was the same 212 tokens, 71 multiplier updates and 6 name
changes, with the factory's nonce still 213; only the block and time the list covers moved forward.

**Prices (Chainlink).** Feed addresses come from Chainlink's reference data directory,
`https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json` (the data behind docs.chain.link's feed tables; it answers with
`Access-Control-Allow-Origin: *`, so the browser fetches it, at most once per ten minutes). Hyvo uses only the 33 entries labeled
`productTypeCode: "primaryTokenizedPrice"`, all of which match a token in the list by ticker; it leaves out the Robinhood entries without that label
(`Robinhood SGOV-USD`, `Robinhood USAR-USD`, the "24/7" feeds and `GLD / USD`), because the directory does not say what they report. What the price
means, from <https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood> (read 2026-11-09): the feed reports the token's Total Return Value,
the underlying equity's 24/5 market price × the token's `uiMultiplier()`; while `oraclePaused()` is true the feed holds its last value; off-hours it may
hold its last price with no heartbeat. The session table (pre-market, regular, post-market, overnight, weekend, in New York time) is from
<https://docs.chain.link/data-feeds/tokenized-equity-feeds>; holidays are not in it, and the page says so. The answer is shown as a reading at a block,
with its update time, never as a quote or a forecast. 179 of the 212 tokens have no such feed, and their pages show no price.

**What a page costs.** A token page makes six JSON-RPC requests from the visitor's browser (the block, the code, the beacon slot, two Multicall3 calls,
the feed) and one directory fetch per ten minutes; nothing reaches Hyvo's Worker. The package takes any viem client, so a CLI command or the Worker can
reuse it; in the Worker one report would be about six subrequests of the 50 allowed (not measured there yet). No cron trigger is used.

**Left out of StockSync, and why.** The bar above every page that showed StockSync's own community token and its contract address: Hyvo does not
promote another project's token. Its launch posts and captions (`marketing/`): outreach. Everything that came from Robinhood's Stock Token API: session
tradability per token (market, extended, overnight), bid and ask quotes, corporate actions by type (dividend, split, merger, with their rates), ISIN and
the API's other fields; the chain has none of these, and the API's terms are unclear (below). The playground and agent pages that ran StockSync's CLI and
MCP server inside the site, its `/status` and `/system` pages and its rendered docs: `@hyvo/stocks` keeps the same questions for a later CLI command or
MCP tool. StockSync takes no payments, holds no funds and gates nothing, so nothing else had to go.

**Founder: decide.**

- **Is the on-chain evidence enough** to present the factory's record as the check of a genuine Robinhood stock token? Today the pages name the factory
  and show the evidence above, without saying "official".
- **Robinhood's Stock Token API** would add session tradability and the type of each corporate action. Its terms of use are unclear here, the ISP
  block keeps it out of reach from this laptop (item 14), and Robinhood Chain's terms limit reuse of docs.robinhood.com's content. Hyvo does not call
  it until you decide; a Worker could, since Workers resolve `*.robinhood.com`.
- **Chainlink's directory and docs**: Chainlink's Terms of Service (<https://chain.link/terms>) cover them; Hyvo reads feeds on-chain, which is their
  documented use, links Chainlink's page, and repeats no table from it. **Confirmed by the founder on 2026-11-09.**
- **The `terms()` link** each token returns (`https://robinhood.com/stocktoken/rhj`) is shown as the contract returns it.
- **Refreshing the list** is by hand: `pnpm --filter @hyvo/stocks scan`, then commit `snapshot.json`. Say if it should run on a schedule; the
  account's cron triggers are shared, so it would need a free slot or a machine.

## 29. Pons launches for Hyvo Launches — verified / decision

Hyvo Launches (`/launches`, `/launches/:token`, `packages/launches`) rebuilds the founder's launch index (Cloesius) and Pons Atlas inside Hyvo.
Everything below was read or measured on 2026-11-09.

**The data path.** The visitor's browser reads Robinhood Chain itself, through keyless public endpoints: no Worker route, no cron trigger,
no storage and no third-party API. Measured on the production build from this machine against the real chain: the newest launches show in
about 3 s, a 6-hour window (about 170 launches, the most traded curves and the map) in 5 to 9 s, with 33 requests and about 620 KB; one
launch's page takes 16 requests and about 50 KB. Each fact is read at one block, and the page names it: "Measured on-chain at block N. Not a
trading signal."

**Contracts.**

- The Pons V2 launch factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` is verified on Sourcify (exact match, verified 2026-08-04, solc 0.8.35,
  deployed in block 26,841,846), and its sources include `PonsV2BondingCurve.sol`, `PonsV2LauncherToken.sol` and `interfaces/ILaunchpadV2.sol`.
  Every event and function Hyvo Launches uses is copied from them (`packages/launches/src/pons.ts`): `TokenLaunched`, `PoolGraduated`,
  `getLaunchedToken(token)` (the launch record: curve, deployer, creator fee recipient, pair token, graduation threshold, tick spacing,
  creator tax, buyback, phase, exists) and, on each curve, `realQuoteReserve()`, `launchedAt()`, `creatorTaxBps()`, `feeBps()`, `graduated()`,
  `launchSupply()`, `reservedTokens()`, `sellableTokens()`, `snipeTaxStartBps()`, `snipeTaxSeconds()`, `CurveBuy` and `CurveSell`. Source:
  `https://sourcify.dev/server/v2/contract/4663/<address>`.
- The active Pons V1 factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` is verified there too, with `getLaunchedToken(address)`; the legacy one
  (`0x0c37a24F5D23A486FA692d1500881d698B1F77a4`) is not. A V1 token's page says it is a V1 launch and shows its record.
- Pons's docs answered this machine with a country block (`docs.ponsfamily.com/blocked?country=GB`), and the repository an earlier project cited
  for the events (`github.com/ponsdotdev/ponsfamily`) answers 404. The verified source is the reference.
- `CurveBuy.quoteIn` is what the buyer spent, fee and tax included, and `CurveSell.quoteOut` what the seller received after them
  (`PonsV2BondingCurve.buy` and `sell`). "Traded" adds `quoteOut + fee + tax` for a sell, so both sides count before fee and tax.
- Anyone can deploy a contract that emits an event named `CurveBuy`. A trade counts only when the factory's record of the emitter's token names
  the emitter as that token's curve; a stand-in impostor in the tests is left out.
- Read on chain: `feeBps()` 100 on the curves read; the factory's `maxCreatorTaxBps()` 1000, `snipeTaxStartBps()` 9900, `snipeTaxSeconds()` 3 and
  `launchEnabled()` true. The ETH launches read graduate at 4.2 ETH with a 1.68 ETH virtual reserve, the USDG ones at 8,090 USDG with 3,236. A
  graduated launch's phase reads 2 (`PoolCreated`), and its record's swept amounts read 0.
- Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` has code on chain 4663 (3,808 bytes). Inside a contract `block.number` is Ethereum's
  block (26,375,626 while the chain was at block 109.86M), so every Multicall3 call also asks ArbSys `arbBlockNumber()` (`0x…0064`) for the
  Robinhood Chain block it read. It answered on dRPC, Pocket and Robinhood's endpoint.
- Pace and volume: 848 V2 launches and 6 graduations between 2026-11-08 04:28 and 2026-11-09 06:25 UTC; 749 paired with ETH, then TSLA 34,
  USDG 20, NVDA 18 and eight other assets with 1 to 8 each. 9.62 blocks a second over 500,000 blocks.

**Endpoints**, from chainlist.org (`rpcs.json`) and ethereum-lists (`eip155-4663.json`), each called with an `Origin: https://hyvo.run`; all
of them answer with CORS headers:

| Endpoint | `eth_getLogs` | Used for |
|---|---|---|
| `robinhood.drpc.org` | about 100 blocks (101 answered, 500 refused: "ranges over 10000 blocks are not supported on free plan") | calls and headers, first |
| `robinhood.api.pocket.network` | often refuses a query without an address ("missing required field 'address'"), and takes ten addresses at most; 10,001 blocks on 8 of 10 tries and 50,000 on 2; adds `blockTimestamp` | logs first, calls second |
| `rpc.mainnet.chain.robinhood.com` | 250,000 blocks with an address, 30,000 without one; JSON bodies only (HTTP 415 otherwise) | logs without an address; logs and calls after the others |
| `rpc.degenprotocol.io/robinhood` | varies by node: 50,000 or 250,000 blocks, sometimes without an address | logs, last |
| `rpc-robinhood.blockmachine.io` | keyless: the last 5,000 blocks only | not used |
| `robinhood-rpc.publicnode.com` | refused: "Archive requests require a personal token" | not used |
| `api.blockvectra.com/v1/robinhood_mainnet/public` | 100 blocks | not used |
| `robinhood.daybreak-rpc.network` | 2,000 blocks | not used |
| `robinhood-mainnet-rpc.blockreq.com/v1/rpc/public` | the last 1,024 blocks only | not used |
| `rpc.nodeflare.app/robinhood/public` | HTTP 403 | not used |
| `lb.routeme.sh/rpc/evm/4663` | HTTP 429 at the first call | not used |
| `rpc.ordofi.network` | no connection | not used |

Pocket's docs say "Free public RPC endpoints for dozens of blockchains, with no API key required" and give no number (`docs.pocket.network`).
dRPC, Pocket and degenprotocol accept a JSON-RPC body sent as `text/plain`, which a browser sends without a CORS preflight; that and opening
the log endpoint's connection early took the first facts from 5 to 6 s down to about 3. The reader learns each endpoint's limits from its
refusals, so a change on their side costs a refused request, not an outage.

**GeckoTerminal** answers browsers too (`access-control-allow-origin: *` on `networks/robinhood/new_pools`, `trending_pools` and `dexes`) and
lists Pons as `pons-v2`, `pons-v2-dex` and `pons-dot-family` ("Pons V1"). CoinGecko's docs ("Errors & Rate Limits", docs.coingecko.com): keyless
use has "IP-based rate limiting — shared across all users on the same IP", and the Demo plan, with a key, allows 100 calls a minute. Hyvo
Launches does not use it: the chain gives the same launches with a block number, and no third party sits in between.

**Chain Pulse** (a section of `/launches`, `packages/launches/src/pulse.ts`) counts the last 24 hours whatever window the visitor picked, in the
browser, with no Worker route, cron trigger or storage. It reuses the launches and graduations the window already read and asks the factory
only for the hours before the window, then reads those launches' curves in the same Multicall3 batches as the list. The counts by pair asset and
the graduations show first, from the events alone (plus a read of any new pair asset's symbol); creator taxes, where each launch trades and
shared symbols and names follow once every curve is read. With the default 6-hour window that is about 18 more hours of factory events and the
curve reads of their launches (about 590 launches at the pace measured above, 848 in about 26 hours); with the 24-hour window nothing more is
read. Its facts, from the verified
source: a curve's `graduated()` turns true when it is swept, and the factory emits `PoolGraduated` right after it creates the Uniswap V4 pool
(`PonsV2LaunchFactory.sol`), so a launch counts as "in its Uniswap V4 pool" once that event is seen, "on its Pons curve" while `graduated()` is
false, and "off its curve, no pool yet" otherwise. Two launches share a symbol or a name when they match apart from case, spaces and a leading
`$`; the page says that a shared name says nothing about either token.

**Snipe-tax exemptions are left out of the pulse**, because nothing the page reads holds them. In the verified source each launch exempts its
creator and creator fee recipient automatically and up to 32 more wallets the creator declares (`MAX_SNIPE_TAX_EXEMPTIONS`), through the curve's
`exemptFromSnipeTax`, which sets `snipeTaxExempt(account)` and emits `SnipeTaxExempted(address indexed account)` from the curve, in the launch
transaction. The page's reads are the factory's `TokenLaunched` and `PoolGraduated` events and the curves' state; the mapping cannot be listed,
and the events come from each curve, so counting them would need one more log query per launch block or per ten curves on Pocket (about 780 launches a day),
or a query without an address that only Robinhood's endpoint answers over 30,000 blocks at a time. Not cheap enough for a page that loads in
seconds; a keyed endpoint (Founder, point 1 below) would make it one query.

**Left out of the source projects:** Cloesius's creator claims and its Pro pages with their payments in its own token, the leads and outreach
dashboard, the creator-edited pages and images, its D1 index and the every-minute cron trigger that fed it; Pons Atlas's stock price API
(unreachable from here) and its decorative orbit motion. Creator-written token fields (logo URL, description, social links) are not shown.

**Founder:**

1. "Most traded" asks for every curve's trades in one log query without an address. Pocket answers that on some tries and refuses it on
   others, and then it goes to Robinhood's own endpoint, whose terms say it is rate limited and not for production (item 3), and which some
   ISPs block (item 14). When no endpoint answers it, the page counts the newest launches' curves only, and says so. A keyed endpoint that
   serves such queries (Alchemy, item 3) would remove the dependence; decide whether to get one.
2. Real token names and symbols appear, because visitors look them up. Only on-chain facts are shown and nothing rates a token. **Confirmed by the founder on 2026-11-09.**
3. Launches is in the footer and the product list (a new Explore group), not in the header. Decide whether the header gets it.

## 30. Hyvo Check: addresses and limits — verified

`packages/check` (`@hyvo/check`) reads a token at one block and runs an exit simulation in one `eth_call`
(`chain/src/probes/SellCheck.sol`, never deployed). Every address it uses, where it comes from, and how it was
confirmed on-chain, with read-only calls to `https://robinhood.drpc.org` on 2026-11-09 (the router and factory reads at block
109,837,577).

| Contract | Address | Source | Confirmed on-chain |
|---|---|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Robinhood Chain docs, Token Contracts (`docs.robinhood.com/chain/contracts`); item 5 | `Router02.WETH()`, `SwapRouter02.WETH9()` and `QuoterV2.WETH9()` return it |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | item 4; Robinhood Token Contracts | Sourcify: EIP-1967 proxy, implementation `0x68184C449E1a8f34fA18d289737129FD27B66f8F` |
| Uniswap V2 Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | Uniswap `deployments.json` (below); item 5 | |
| Uniswap V2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` | Uniswap `deployments.json`; Uniswap v2 deployments page | `Router02.factory()` and `SwapRouter02.factoryV2()` return it. Read from the router on every check, not hardcoded |
| Uniswap V3 SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` | Uniswap `deployments.json` | the Pons v1 factory's `getDexConfig(0).swapRouter` |
| Uniswap V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | Uniswap `deployments.json` | `SwapRouter02.factory()`, `QuoterV2.factory()` and Pons v1 `getDexConfig(0).factory` return it. Read from SwapRouter02 on every check |
| Uniswap V3 QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | Uniswap `deployments.json` | its `factory()` and `WETH9()` match SwapRouter02's |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Uniswap `deployments.json`; Uniswap v4 deployments page | the Pons v2 factory's and hook's `poolManager()` return it. Pons pools use the factory's answer on every check |
| UniswapInterfaceMulticall | `0x282A3C4D320Cc7f0d5eaf56B8029e4B88338f0a3` | Uniswap `deployments.json` | its bytecode dispatches `multicall((address,uint256,bytes)[])` (`0x1749e1e3`); a live batch answered |
| Pons v2 factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | item 5 | Sourcify exact match (`PonsV2LaunchFactory`) |
| Pons v2 hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | item 5 | the factory's `memeHook()` returns it; Sourcify match (`PonsV2MemeHook`). Read from the factory on every check |
| Pons v1 factory | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | item 5 | Sourcify exact match (`PonsLaunchFactory`) |

Uniswap's list: `https://developers.uniswap.org/deployments.json` (read 2026-11-09), generated 2026-11-04 from `github.com/Uniswap/contracts`
at commit `036160f`, every row above with status `active` for chain 4663.

**Not used:** Aleph's registry named a V4 "UniversalRouter" `0xC6da9C87caE2fcecad79E22C398dE16BFAb0cFdA` and a V3 router
`0x44e613593d7CC00164D790f2636aC2e2ED7dd292`, found by name on Blockscout. Neither is in Uniswap's list for chain 4663, so Hyvo
Check does not use them.

**Sources other than the chain.**

- **Sourcify** (`https://sourcify.dev/server`, keyless): `GET /v2/contract/4663/<address>?fields=abi,deployment` answers 200 with
  `match` `exact_match` (full) or `match` (partial), the ABI and the deployment (deployer, transaction, block), and 404 with `match: null`
  when the contract is not verified. It answers browsers (`access-control-allow-origin: *`) and sends `Cache-Control: public,max-age=3600`.
  Its rate limits were not checked.
- **Blockscout** stays optional (item 24): `api.blockscout.com/4663/api/v2/...` answered `402 {"error":"Proceed with API key or make a X402
  payment to continue"}` without a key on 2026-11-09. `@hyvo/check` calls it only with `blockscoutKey`, for holders, and as a second source
  for verification and the deployer. `tokens/<address>`, `tokens/<address>/holders` and `smart-contracts/<address>` are **verified** with the
  founder's key (item 24, 2026-11-09). `addresses/<address>`, read for `creator_address_hash` and `creation_transaction_hash`, is the same
  API's standard route but **likely**, not tried with a key yet: if it answers otherwise, the deployer falls back to "unknown", never to a
  wrong address (every field is checked before use).
- **Hyvo's API reads the holders with its own key** (decision, 2026-11-09). The Worker secret `BLOCKSCOUT_API_KEY` (set by the deploy from the
  repo's `.env`) lets `GET /v1/check/:token`, `check_token` and `GET /v1/check/:token/holders` fill the top holders, and the deployer when
  neither a launch record nor Sourcify names one; the /check page asks the holders route while the browser reads the chain. The key goes to
  Blockscout only; a test with a fake key checks every answer, header and log for it (`apps/api/test/holders.test.ts`). Three requests per
  token, each once (a `429` is reported, not retried), kept ten minutes in the Cache API; 10 reads a minute per IP on the holders route and 60
  a minute for the Worker, under the free tier's 5 requests a second. Inside a check they bring the worst case to 49 of the 50 subrequests a
  free-plan request may make. Without the key, or when Blockscout fails, the two findings say `skipped` and why. **Open:** what one request
  costs of the free tier's 100,000 daily credits, and the CPU of parsing a real holders page in the Worker; both to measure once deployed.
- **dRPC** honors state overrides in `eth_call` (as does PublicNode), and answered the probe's 30M-gas call; its CORS preflight allows
  `https://hyvo.run`.

**Measured on 2026-11-09** (`pnpm --filter @hyvo/check check <address>`; 0.001 ETH; no Blockscout key): 7 to 10 JSON-RPC requests and 1 Sourcify
request per token (2 for a proxy), 1 to 3.4 s.

| Token | Venue found | Exit simulation |
|---|---|---|
| `0x8eee67a8aad993f15b4506975b38c52f6d3ce758` | Uniswap V2 pair with WETH | every step as quoted; round trip 0.59% |
| `0x54cf6d6c466cb0cd72d113462746c674e546b274` | Pons v2 curve (fee 1%, creator tax 1%) | every step as the curve's math after fee and tax; round trip 3.95% |
| `0xec243bbae17a826462b0bf006705feca0959c703` | Pons v2 curve (fee 1%, creator tax 2.89%) | as above; round trip 7.63% |
| `0x51250b135174ca09450ec01c4aff73cf69dbb590` | Uniswap V4 pool with the Pons hook | every step as the swap delta; round trip 1.99% |
| `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (USDG) | Uniswap V2 pair with WETH | every step as quoted; round trip 0.6% |
| `0xb895712c93d3a85372e90c7d0d11d3ead4e1c303` | none: its V3 pool holds no WETH and no in-range liquidity | skipped |
| `0xa7bcbc1aae192fc60c5b18e67e0dce00532619f9` | a V4 pool outside Pons | skipped: not covered yet |

Planted tokens, inside one `eth_call` (the research variants `TokenVariants.sol` in place of `0x8eee67a8…ce758`'s code, through the real Router02): a 5% transfer tax
showed as 5.00% short on the buy, the transfer and the sell; a token that refuses transfers into its pair bought and sent normally, and its
sell reverted with `Error("TransferHelper: TRANSFER_FROM_FAILED")`.

**Limits.**

- Not simulated yet: V4 pools outside Pons (their pool keys are not read), Pons launches quoted in another token (the factory approves USDG
  as a pair token), launches between their curve and their V4 pool, and pools quoted in anything but ETH or WETH.
- One block, one fresh sender, one amount: a token can behave differently for later blocks, other senders or larger amounts.
- Proxies are followed through EIP-1967 and EIP-1167. USDG's implementation routes some calls through facets (`setFacet(bytes4,address)`), so
  functions that live in a facet are not in its ABI.
- Holders come from Blockscout's index (a key: item 24; through Hyvo's API, above), not from the block the rest is read at, and an index can
  trail the chain. Only Blockscout's first page (50 holders) is read, so the deployer outside it is named as not listed.
