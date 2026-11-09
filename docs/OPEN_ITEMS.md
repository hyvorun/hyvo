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
| 18 | Price parameters | decision | ×2.5, floor $1, step $1; on Workers AI $0.00005 per agent-round, $0.008 report (measured) |
| 19 | Refunds for partial runs | decision | not automatic; reviewed in `/admin` |
| 20 | Mobile wallets without an injected provider | decision | injected wallets only (no WalletConnect) |
| 21 | Cloudflare Workers plan | resolved | Workers Free; one trade-off to confirm (SPEC §8.4) |
| 22 | Phases 4 to 7 before the token launch, on free plans | decision taken | what needs money or an always-on machine waits, see below |
| 23 | Narrative Engine sources; real token names in public runs | verified / decision | GeckoTerminal and RSS, keyless; `--seed-packs` off by default |
| 24 | A wallet's history for Wallet Clone | verified / decision | `BLOCKSCOUT_API_KEY=` empty: clones are off until the founder makes a free key |
| 25 | How far back Rewind can fork | verified | a few days dependably on dRPC's free tier, further on and off; an archive RPC for more |
| 26 | Unused prepaid balance | decision | no self-serve refund; by hand from `/admin` |
| 27 | Publishing `@hyvo/sdk` to npm | decision | not published yet |

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
  `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`.
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

Founder, 2026-11-06: the revenue gates are lifted and the token launches last, after Phase 7. Free plans stay the rule, and
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

**Founder:** make a free key at dev.blockscout.com and put it in the runner's `.env` as `BLOCKSCOUT_API_KEY`. It costs nothing. Until then `/clone` says clones are not open yet.

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

