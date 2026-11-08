# Hyvo

Put a token launch, a rumor or a listing in front of a crowd of AI traders before the real one happens. For each run,
Hyvo starts a private fork of Robinhood Chain (chain ID 4663) and fills it with agents that post, reply and swap against
real constant-product AMM math, round by round. The whole run is published as one hashed file that anyone can replay and
check.

**Results are synthetic crowd reactions. Not a trading signal.** Agents are archetypes with generated handles, never
real people, and the tokens in the example scenarios are fictional. Nothing a run does reaches the public chain, apart
from its hash.

- Web: <https://hyvo.pages.dev>
- API: <https://hyvo-api.artallm.workers.dev/v1/health>
- [HyvoOracle](https://robinhoodchain.blockscout.com/address/0x2FEDc123c38B069cf78e5915852A61022E347642) and
  [PaymentRouter](https://robinhoodchain.blockscout.com/address/0x9ca245cA96dE8BFC13Df4a233ba6E2EcEc9AC6d1) on Robinhood
  Chain, with verified sources. Paid runs are not open yet.

## Check a run yourself

You do not have to trust the site.

1. **Get the file.** `GET /v1/runs/featured` names a run; `GET /v1/runs/<runId>/artifact` gives a link to its exact
   `run.json`.
2. **See who played it.** `crowd.model` names the language models, or `offline/rules-v1` for the rules model used in
   tests. `world.forkBlock` is the Robinhood Chain block the private fork started from; `null` means a plain local chain.
3. **Recompute the hash.** Remove the top-level `hash`, canonicalize the rest with RFC 8785 (JCS) and take keccak256. It
   must equal the file's `hash`. The run page does this in your browser.
4. **Replay the market.** Every swap in the file can be replayed against the constant-product formula, and must give the
   recorded prices. `uv run python -m hyvo verify <run.json>` in `engine/` checks the hash, the schema, the rules and the
   price path. The trades happened on the private fork, so their transaction hashes are not on the public chain.
5. **Compare with the chain.** Once a run is committed, `getCommit` on the HyvoOracle contract returns its hashes, and
   the `/oracle` page compares them in your browser. The full procedure, with test vectors, is in
   [`docs/API.md`](docs/API.md#verifying-a-run).

## What is in the repo

| Path | What it is |
|---|---|
| `engine/` | Python 3.11 (uv). The simulation: fork, agents, feed, swaps, report, `run.json`. `engine/mirofish/` is upstream [MiroFish](https://github.com/666ghj/MiroFish), kept as a subtree |
| `chain/` | Foundry. `HyvoOracle` (commits run hashes once) and `PaymentRouter` (forwards a payment to the treasury in the same call; it never holds funds) |
| `apps/web` | The site: React and Vite on Cloudflare Pages |
| `apps/api` | The API: a Cloudflare Worker with Hono, D1, KV and Workers AI |
| `packages/schema` | zod schemas for `run.json` and the API, and the hash, in TypeScript. The engine computes the same hash in Python, and both are tested against one recorded run |
| `fixtures/` | That recorded run, and the showcase run |
| `docs/` | [`SPEC.md`](docs/SPEC.md), [`API.md`](docs/API.md), [`RUNBOOK.md`](docs/RUNBOOK.md), [`OPEN_ITEMS.md`](docs/OPEN_ITEMS.md) |

## Run it locally

You need Node 22+ and pnpm 11, Python 3.11 with uv, and Foundry.

```
pnpm install
cd engine && uv sync
uv run python -m hyvo run --scenario examples/scenarios/pons-creator-tax.md --agents 50 --rounds 10 --offline --no-fork
```

That plays a run with the offline rules model on a local chain, at no cost. Language models and a real fork are set in
`.env` ([`.env.example`](.env.example)). The API, the web app and the runner are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Non-custodial

Hyvo never holds, approves or moves users' tokens. Signing in is a signature, never a transaction. A payment goes from
the payer to the treasury in one call to `PaymentRouter`, for exactly the quoted amount. The contracts are small,
non-upgradeable and built on OpenZeppelin.

## License

Hyvo is free software under the GNU Affero General Public License, version 3 or later ([`LICENSE`](LICENSE)). The
engine builds on [MiroFish](https://github.com/666ghj/MiroFish), which is AGPL-3.0; `engine/mirofish/` keeps its upstream
license and notices.
