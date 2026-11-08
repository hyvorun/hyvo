# Fixtures

## `golden-run.json`

The golden run (spec §13): one recorded `run.json` that the web replay, the API and hash verification are
tested against in both languages (`packages/schema/test/golden.test.ts`, `engine/tests/runfile/test_golden.py`).

It was produced by the offline rules model, so it costs nothing to reproduce in shape (a new run gets a new
`runId`, `createdAt` and hash):

```
cd engine
uv run hyvo run --scenario examples/scenarios/pons-creator-tax.md --agents 50 --rounds 10 \
    --offline --no-fork --seed 20261103
```

`crowd.model` says `offline/rules-v1`: its posts come from templates, not from a language model. That is on purpose:
when the engine changes what it writes, the golden run can be made again at no cost. After that, put the new hash
in both tests and run `pnpm --filter @hyvo/schema gen` for the summary vector.

It is a synthetic crowd reaction, not a trading signal.

## `showcase-run.json`

The home page's first run: a 50 x 10 run played by a language model on Cloudflare Workers AI, on a fork of Robinhood Chain
at the block in `world.forkBlock`, with its report written by a stronger model (`crowd.model`). The deploy script publishes
it on a new account only; after that, `hyvo publish --featured` does. Unlike the golden run it cannot be reproduced, because
model output varies, so its tests check what it is rather than a fixed hash (`packages/schema/test/showcase.test.ts`,
`engine/tests/runfile/test_showcase.py`).

Twelve of its posts read `[Removed by the copy guard.]`, and `report.flags` says `posts_removed:12`. Seven were taken out
by the last read before the run was hashed. Five were taken out by `hyvo scrub` after a person read every post and the
guard was tightened to catch them.

To make a new one, with the `LLM_*` settings of `.env.example` for Workers AI and `RH_RPC_URL` for the fork (about 3,000 of
the 10,000 free neurons a day):

```
cd engine
uv run python -m hyvo run --scenario examples/scenarios/pons-creator-tax.md --agents 50 --rounds 10 \
    --fork --seed 7 --max-cost-usd 0.2 --max-llm-calls 130
```

Read every post before publishing, because the hash goes on-chain for good. `hyvo scrub <run> --remove p3,c9` takes out what
must not go there, and is only possible before the run is published.

It is a synthetic crowd reaction, not a trading signal.

## `dryrun-sample.json`

A Dry Run report of `chain/src/test-assets/SampleVault.sol`, a contract with two bugs planted on purpose, played by the offline
crowd. The API's and the web app's tests use it (`apps/api/test/dryruns.test.ts`, `apps/web/e2e/phase6.spec.ts`). When the engine
changes what a report says, copy a new `dryrun.json` over it:

```
cd engine
uv run python -m hyvo dryrun examples/dryrun/sample-vault.json --offline --out <folder>
```


## `ten-personas-run.json`

A small run with two agents of each kind of trader, played by the offline model, so that both languages and the web app are tested on a real file with the later personas in
it (`engine/tests/runfile/test_ten_personas.py`, `packages/schema/test/showcase.test.ts`, `apps/web/e2e/phase7.spec.ts`). It is a synthetic crowd reaction, not a trading signal.
