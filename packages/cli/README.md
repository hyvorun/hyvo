# hyvo

Hyvo in your terminal, for Robinhood Chain (chain 4663).

- **`hyvo check <token>`** reads a token at one block and lists what it found, each fact with its evidence: verified
  source, owner, proxy, mint, fee, blocklist and pause functions, where it trades, the top holders and the deployer.
  Then it simulates an exit inside one read-only `eth_call`: it buys the token with made-up ETH, sends a tenth to a
  fresh address, sells the rest, and compares each step with what the venue's own math promised.
- **`hyvo launches`** lists the newest Pons launches with the facts their contracts hold: the pair asset, the phase,
  the creator tax and what each bonding curve holds. `hyvo launches <token>` reads one launch in full.
- **`hyvo stocks <ticker>`** reads a Robinhood stock token: whether the StockFactory records that contract for its
  ticker, its multiplier, its Chainlink price and what it means, and whether it can move right now.
- **`hyvo verify <runId>`** proves that a published Hyvo run is the one committed on-chain: it recomputes the run's
  hash from its `run.json` and compares it with the commit in HyvoOracle, read from Robinhood Chain.
- **`hyvo mcp`** gives all of them to an AI agent as an MCP server.

```sh
npx @hyvo/cli check 0x54cf6d6c466cb0cd72d113462746c674e546b274
npx @hyvo/cli launches --hours 1
npx @hyvo/cli stocks NVDA
```

hyvo only reads. It never asks for a key, never signs, never sends a transaction, has no account or login, and sends
no telemetry. A check states facts and gives no verdict: it never says what to do with a token and never predicts a
price. Every check, launches and stocks result ends with **"Measured on-chain at block N. Not a trading signal."**
Every run result carries **"Synthetic crowd reaction. Not a trading signal."**

## Install

Node.js 20 or later.

```sh
npx @hyvo/cli --help        # run without installing
npm install -g @hyvo/cli    # or install the `hyvo` command
```

## Commands

| Command | What it does |
|---|---|
| `hyvo check <token>` | Facts about a token, each with its evidence, and an exit simulation. Also `hyvo scan`. |
| `hyvo launches [<token>]` | The newest Pons launches with their curves' state, or one launch in full. |
| `hyvo stocks [<ticker\|address>]` | Robinhood's stock tokens from Hyvo's scan, or one token read live. |
| `hyvo watch [<token>...]` | Re-checks tokens on an interval and prints what changed. |
| `hyvo watchlist` | The tokens `hyvo watch` follows, kept in a local file. |
| `hyvo runs` | Recent published runs of Hyvo's crowd simulation. |
| `hyvo verify <runId>` | Recomputes a run's hash and compares it with its commit on Robinhood Chain. |
| `hyvo mcp` | A Model Context Protocol server on stdio, with a tool for `check`, `launches`, `stocks` and `verify`. |
| `hyvo config` | Where hyvo reads from: the RPC and the API. |

`hyvo <command> --help` shows each command's options. Every command but `mcp` takes `--json`.

### `hyvo check <token>`

```
hyvo check <token> [--json] [--eth-in <eth>] [--block <n>] [--rpc <url>]
```

| Option | Default | |
|---|---|---|
| `--json` | | The report as JSON, amounts as decimal strings. |
| `--eth-in <eth>` | `0.001` | What the exit simulation buys with, from 1 wei to 1000 ETH. It is made-up ETH inside the call. |
| `--block <n>` | two below the head | The block to read at. A node without that block's state cannot answer. |
| `--rpc <url>` | `https://robinhood.drpc.org` | A Robinhood Chain JSON-RPC endpoint. The answer must say chain 4663. |

A real report, read on 2026-11-09 from a token launched on a Pons bonding curve (four findings left out at the `…`):

```
  HYVO CHECK   Nodal (NODAL)                                                  Robinhood Chain · 4663
  0x54cF6d6c466cB0Cd72d113462746c674e546B274 · block 109887933

  not found  Verified source
             Sourcify has no verified source for 0x54cF…B274 on chain 4663; Blockscout was not asked
             (no API key)
  not found  Owner address
             neither owner() nor getOwner() answers
  not found  Mint function
             none of mint(address,uint256), mint(uint256), mint(address), mintTo(address,uint256),
             increaseSupply(uint256), increaseSupplyToAddress(uint256,address) in the bytecode's
             dispatcher
  …
  found      Trading venue
             the Pons v2 bonding curve 0x2DE9…b4c9, quoted in native ETH: curve fee 1%, creator tax
             1%, snipe tax at this block 0%
  not found  Sell or transfer shortfall
             at block 109,887,933 through the Pons v2 curve 0x2DE9…b4c9: the buy of 0.001 ETH
             delivered 582,835.84 tokens, matching the curve's math after its fee and taxes; sending
             58,283.58 to a fresh address delivered 58,283.58 (in full); the sell brought back
             0.00086441 ETH, matching the curve's math after its fee and taxes; the round trip lost
             3.95% of what the sold part cost
  skipped    Top holders
             needs a Blockscout API key, and none was given: the explorer refuses programs, and its
             API answers only with a key
  found      Deployer
             launched by 0xc985…b35A through Pons v2: getLaunchedToken on its factory 0x7eD5…EC7e
             records it

  Exit simulation   Pons v2 curve 0x2DE9…b4c9 · 0.001 ETH in · inside one eth_call
  step        promised           arrived            short    gas
  buy         582,835.84 NODAL   582,835.84 NODAL   0%       68,622
  transfer    58,283.58 NODAL    58,283.58 NODAL    0%
  sell        0.00086441 ETH     0.00086441 ETH     0%       22,035
  round trip  3.95% lost: the part sold cost 0.0009 ETH at the buy's average price, and 0.00086441
              ETH came back

  Read in 5.8 s: 8 requests to robinhood.drpc.org and 1 to sourcify.dev. Nothing was signed or sent.
  Measured on-chain at block 109887933. Not a trading signal.
```

Each finding is `found` (the check found what it looks for), `not found` (it looked; the evidence says where) or
`skipped` (it could not look; the evidence says why). A skipped check is shown, never dropped. What each check looks
for, the venues the simulation covers and its limits are in [`packages/check/README.md`](../check/README.md) in the
Hyvo repository.

`--json` prints the report as [`@hyvo/check`](../check/README.md) defines it, with every amount as a decimal string,
plus the disclaimer:

```jsonc
{
  "chainId": 4663,
  "token": { "address": "0x…", "name": "Nodal", "symbol": "NODAL", "decimals": 18, "totalSupply": "1000000000000000000000000000" },
  "block": "109887933",
  "findings": [{ "id": "source", "title": "Verified source", "status": "not_found", "evidence": "…" }, …],  // 11, in a fixed order
  "exit": {                       // null when no venue was found or the simulation could not run
    "venue": { "kind": "pons-curve", "curve": "0x…", "curveFeeBps": 100, "creatorTaxBps": 100, "snipeTaxBpsNow": 0 },
    "ethIn": "1000000000000000", "payout": "eth",
    "buy":      { "ok": true, "promised": "…", "arrived": "…", "shortfallPct": 0, "gas": "68622", "reason": null },
    "transfer": { … }, "sell": { … },
    "roundTrip": { "spent": "900000000000000", "back": "864410387740650", "lossPct": 3.9544 }
  },
  "code": { "bytes": 3248, "proxyImplementation": null, "owner": null, "ownerRenounced": false, "sourcify": "none" },
  "timings": { "totalMs": 5784, "chainMs": 5389, "simulationMs": 340, "sourcesMs": 2321, "requests": { "rpc": 8, "sourcify": 1, "blockscout": 0 } },
  "notice": "Facts read from Robinhood Chain at one block, each with its evidence. Not a trading signal, and not an audit.",
  "disclaimer": "Measured on-chain at block 109887933. Not a trading signal."
}
```

Finding ids are stable: `source`, `owner`, `proxy`, `mint`, `fee-setter`, `blocklist`, `pause`, `venue`,
`sell-simulation`, `holders`, `deployer`. A failure prints `{ "error": { "code", "message" } }` instead.

Exit codes: `0` a report was made, whatever it found; `2` no report could be made (not a contract, not a token, the
RPC did not answer); `64` usage error. The exit code never depends on the findings.

### `hyvo launches [<token>]`

```
hyvo launches [--hours <1|6|24>] [--limit <n>] [--rpc <url>] [--json]
hyvo launches <token> [--rpc <url>] [--json]
```

Reads Pons launches from Robinhood Chain with [`@hyvo/launches`](../launches), the reader the
[Launches page](https://hyvo.run/launches) uses: the `TokenLaunched` and `PoolGraduated` events of the Pons V2 launch
factory over the window, then each listed launch's bonding curve in one Multicall3 call at one block. `--hours` takes
1, 6 or 24 (default 6); `--limit` lists 1 to 100 of the newest (default 20). Without `--rpc`, it reads through the
public endpoints `@hyvo/launches` measured (dRPC, Pocket, Robinhood's own and degenprotocol), each asked for what it
serves; an endpoint you choose must answer `eth_getLogs`.

A real list, read on 2026-11-09 (three rows left out at the `…`):

```
  HYVO LAUNCHES   Pons V2, the last hour                                      Robinhood Chain · 4663
  blocks 109980889 to 110015560 · curves read at block 110015583

  17 launches in the last hour. Paired with: ETH 15, NVDA 2. No curve graduated to its pool in these blocks.

  age      token     pair   phase          on its curve                  creator tax   address
  6 min    BELL      ETH    on its curve   0.06026 of 4.2 ETH, 1.4%      0%            0x603fB6713014Fa7E936763ABafD244B8Eb7cE0a7
  11 min   NASU      ETH    on its curve   <0.000001 of 4.2 ETH, 0%      1.5%          0xC89E27CdD395C265905Aa728751E258aD204549C
  12 min   CHROM     ETH    on its curve   0.01018 of 4.2 ETH, 0.2%      2%            0x3899754a0Ee5117368f1b5180883eFE5Bc2CB507
  …
  46 min   LORIS     ETH    on its curve   <0.000001 of 4.2 ETH, 0%      1%            0x08087371b71Db6CebFBf8C0ffD0BcAe33F30FB2f

  9 more in the window: hyvo launches --hours 1 --limit 17
  One launch's facts: hyvo launches <token>

  The phase is the curve's own graduated(); what a curve holds is its realQuoteReserve() of the pair asset,
  towards the threshold it graduates at. Ages run to the block the curves were read at.
  Read in 3.9 s: 4 requests to robinhood.drpc.org and 4 to robinhood.api.pocket.network. Nothing was signed or sent.
  Measured on-chain at block 110015583. Not a trading signal.
```

A terminal too narrow for full addresses gets them shortened, and `--json` always has them. `hyvo launches <token>`
reads the factory's record and the curve in full: the phase, how far the curve is towards graduation, the pair
asset, the creator tax, the trading fee, the buyback, the launch-second tax, the supply, what is kept for the pool and
left to buy, when it launched, the creator and the curve, and the last hour of `CurveBuy` and `CurveSell` events on
its curve. A Pons V1 token, or an address Pons has no record of, is said to be one.

`--json` prints the list as `{ chainId, window, block, timestamp, launches, notListed, graduations, disclaimer }`:
each launch with its `pair` asset, `graduated`, `creatorTaxBps`, `liquidity` and `graduationThreshold` (decimal
strings in the pair asset's smallest unit) and `progress` (their ratio). `graduations` holds every `PoolGraduated` of
the window's blocks, with `launchedInWindow` false for a curve that launched before the window, so it is not a count
of the window's launches. One launch prints `kind` (`v2`, `v1` or
`none`), the record and curve as read, `lastHour`, `block` and the disclaimer.

### `hyvo stocks [<ticker|address>]`

```
hyvo stocks [--search <text>] [--rpc <url>] [--json]
hyvo stocks <ticker|address> [--rpc <url>] [--json]
```

Reads Robinhood's stock tokens with [`@hyvo/stocks`](../stocks), as the [Stocks pages](https://hyvo.run/stocks) do.
The list is Hyvo's scan of the chain that ships with this version (every token the StockFactory deployed, and every
multiplier and name change each one recorded), and the factory's nonce is read live to say whether it has deployed
more since. One token is read at one block: its uid, name, multiplier and pause flags, and the factory's
`tokenAddress(uid)`; its price is its Chainlink feed's answer at that block, at the address Chainlink's feed directory
lists. Without `--rpc`, it reads through dRPC, then Pocket, then Robinhood's own endpoint.

A real report, read on 2026-11-09 (the multiplier and history sections left out at the `…`):

```
  HYVO STOCKS   NVDA · NVIDIA                                                 Robinhood Chain · 4663
  0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC · block 110015727 · 9 Nov 2026, 11:17 UTC

  Is this the NVDA stock token?
  Yes. The Stock Token factory records this contract as NVDA.
  The factory deployed it and keeps it under its uid: asked for that uid, the factory answers with this address. A
  copy can take a ticker, a name and a uid, but not this record.

  What its price is
  per token           177.15 USD
                      The feed's answer: 177.15496693 (8 decimals).
  updated             3 min ago, 9 Nov 2026, 11:14 UTC
                      Within the feed's 24 h heartbeat. It also updates when the price moves 0.5%.
  per share           177.02 USD
                      The answer ÷ the multiplier: Chainlink's formula worked backwards, to 8 decimals: 177.01775.
  …
  Can it move right now?
  transfers           open
                      paused() is false: transfers and approvals go through, except for accounts on the
                      registry's blocklist.
  oracle pause        not paused
                      oraclePaused() is false, so Chainlink's feed for it keeps updating.
  US equity session   Mon 06:17 in New York: Pre-market (04:00 to 09:30 ET)
  …
  Read in 3.1 s: 1 request to reference-data-directory.vercel.app and 6 to robinhood.drpc.org. Nothing was signed or sent.
  Measured on-chain at block 110015727. Not a trading signal.
```

A contract the factory does not record, under any name, is said not to be the token, and no price is shown for it.
A ticker the list does not hold exits 2 and names the tickers and names that contain it. `--json` prints the report
as read (`verdict`, `reading`, `multiplier`, `movement`, `session`, `feed`, `listed`), every bigint as a decimal
string, with the block and the disclaimer; the list prints `{ chainId, factory, snapshot, live, search, tokens,
disclaimer }`.

### `hyvo watch [<token>...]`

```
hyvo watch [<token>...] [--interval <s>] [--count <n>] [--eth-in <eth>] [--rpc <url>] [--json]
```

Checks each token (the ones given, else the watchlist) once, then again every `--interval` seconds (default 300, at
least 60), one token after another, and prints what changed: a check moving between found and not found (with the
new evidence), the owner address, the proxy implementation, the total supply and the trading venue. A check that
could not look in a round is not a change. `--count` stops after that many rounds; otherwise Ctrl+C stops it. At most
20 tokens.

It runs on your machine and makes the same reads as `hyvo check`. Nothing is hosted, and nothing is sent anywhere
when something changes. `--json` prints one JSON object per line: `baseline`, `change` and `error` events, each with
the block and the disclaimer.

### `hyvo watchlist`

```
hyvo watchlist                              show it
hyvo watchlist add <token> [--label <name>]
hyvo watchlist rm <token>
hyvo watchlist path                         where the file is
```

Public token addresses, in `watchlist.json` in the settings folder (see [Settings](#settings)). The file stays on
your machine.

### `hyvo runs`

```
hyvo runs [--limit <n>] [--cursor <c>] [--api <url>] [--json]
```

The newest published runs from the Hyvo API (`GET /v1/runs`): each run's id, title, crowd size, rounds, the simulated
market's start and end price, and its hash. A run is a synthetic crowd of AI trader agents on a private fork of
Robinhood Chain; its prices are the simulation's, not the market's. `--limit` takes 1 to 50 (default 10). `--json`
prints the API's answer as is.

### `hyvo verify <runId>`

```
hyvo verify <runId> [--api <url>] [--rpc <url>] [--oracle <address>] [--json]
hyvo verify <file.json> ...
```

1. Downloads the run's exact `run.json` bytes through the API (`GET /v1/runs/:runId/artifact`), or reads the file
   you give, in which case the API is not asked at all.
2. Recomputes the run hash here: keccak-256 of the RFC 8785 form of the file without its top-level `hash`, and the
   scenario hash the same way from `scenario`.
3. Reads `HyvoOracle.getCommit(runId)` on Robinhood Chain through the RPC, at the latest block, and checks the chain
   id is 4663.
4. Compares: the file's hash with what it records, the commit's `reportHash` with the run hash, and the commit's
   `scenarioHash` with the scenario hash.

The oracle address is pinned in the build from `chain/deployments/4663.json` in the Hyvo repository
(`0x2FEDc123c38B069cf78e5915852A61022E347642`); the API is not trusted to name it. `--oracle` reads another contract
instead and says so. What the API records about the commit (its transaction and block) is shown next to the proof,
never as part of it.

```
  HYVO VERIFY   run_01M6QD9NRSBS9QDX37M1NJAEDJ
  Fictional Pons token GLINT lists with a 5% creator tax

  match      run.json hashes to the hash it records
             0xfd39df562d3af4ab89687b42b97036e13f1c96275be068949d5268a92f146ed9
  match      reportHash on chain is that hash
             0xfd39df562d3af4ab89687b42b97036e13f1c96275be068949d5268a92f146ed9
  match      scenarioHash on chain is the scenario's hash
             0x871bb0ce36995f1d1018802291868a3002588fb9db802f3c2566641ee1283676
             committed 2026-11-06 03:23:32 UTC, by the block's own clock
             HyvoOracle 0x2FEDc123c38B069cf78e5915852A61022E347642 on Robinhood Chain (4663), read through
             robinhood.drpc.org at the latest block

  Verified. This run.json is the one committed on Robinhood Chain.

  Synthetic crowd reaction. Not a trading signal.
```

`--json` prints `{ runId, verified, title, file, chain, api, disclaimer }`: the recorded and recomputed hashes, the
commit as read from the chain with `reportHashMatches` and `scenarioHashMatches`, and the API's record.

Exit codes: `0` verified; `1` not verified (a hash differs, or the chain holds no commit for the run); `2` could not
check (no such run, the API or the RPC did not answer); `64` usage error.

### `hyvo mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server on stdio: newline-delimited JSON-RPC on stdin and
stdout, protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. Add it to an MCP client's settings:

```json
{ "mcpServers": { "hyvo": { "command": "npx", "args": ["-y", "@hyvo/cli", "mcp"] } } }
```

| Tool | Input | Returns |
|---|---|---|
| `check_token` | `address` (the token's), `ethIn` (optional, ETH as a string, default `"0.001"`) | the same JSON as `hyvo check --json` |
| `recent_launches` | `hours` (optional: 1, 6 or 24), `limit` (optional, 1 to 100) | the same JSON as `hyvo launches --json` |
| `launch_facts` | `address` (the token's) | the same JSON as `hyvo launches <token> --json` |
| `stock_token` | `query`: a ticker such as `NVDA`, or a contract address | the same JSON as `hyvo stocks <ticker> --json` |
| `verify_run` | `runId` | the same JSON as `hyvo verify --json` |

All are read-only (`readOnlyHint`). A result is returned as text and as `structuredContent`; a failure as
`isError` with the reason. `--rpc` and `--api`, the environment and the settings file apply as they do to the
commands. The server writes nothing but protocol messages to stdout.

### `hyvo config`

```
hyvo config                     the RPC and API in use, and where each comes from
hyvo config set rpc <url>       your own Robinhood Chain JSON-RPC endpoint
hyvo config set api <url>       another Hyvo API, for example a local one
hyvo config unset rpc|api
hyvo config reset
hyvo config path
```

`hyvo config` never prints a URL's path or query, where an endpoint's key can sit.

## Settings

| | Default | Set with |
|---|---|---|
| JSON-RPC endpoint | `https://robinhood.drpc.org` | `--rpc`, then `HYVO_RPC_URL`, then `hyvo config set rpc` |
| Hyvo API | `https://api.hyvo.run` | `--api`, then `HYVO_API_URL`, then `hyvo config set api` |
| Blockscout key | none | `HYVO_BLOCKSCOUT_KEY` only. With a key, `check` reads the top holders from Blockscout's API. It is never written to a file or printed. |
| Settings folder | `~/.config/hyvo` (`%APPDATA%\hyvo` on Windows) | `HYVO_CONFIG_DIR`, or `XDG_CONFIG_HOME` |

The folder holds `config.json` (only after `hyvo config set`) and `watchlist.json` (only after
`hyvo watchlist add`). `NO_COLOR` turns colors off and `FORCE_COLOR` on; output that is not a terminal is plain and
not wrapped.

## Privacy: what hyvo sends, and where

| Command | Destination | What it receives |
|---|---|---|
| `check`, `watch`, MCP `check_token` | the JSON-RPC endpoint (default `robinhood.drpc.org`) | The token address, in `eth_chainId`, `eth_blockNumber`, `eth_getCode`, `eth_getStorageAt` and `eth_call` requests. One `eth_call` carries the simulation with a state override: the probe's code at a throwaway address and made-up ETH. |
| | Sourcify (`sourcify.dev`) | The token address, and its implementation's for a proxy, to look up verified source and the deployment record. |
| | Blockscout (`api.blockscout.com`) | Only with `HYVO_BLOCKSCOUT_KEY` set: the token address and your key. |
| `launches`, MCP `recent_launches` and `launch_facts` | the JSON-RPC endpoint you chose, or else the public endpoints `robinhood.drpc.org`, `robinhood.api.pocket.network`, `rpc.mainnet.chain.robinhood.com` and `rpc.degenprotocol.io` | `eth_getBlockByNumber`, `eth_getLogs` for the Pons factory's and a curve's events, and `eth_call` through Multicall3 with the launches' and curves' addresses. |
| `stocks`, MCP `stock_token` | the JSON-RPC endpoint you chose, or else `robinhood.drpc.org`, then `robinhood.api.pocket.network`, then `rpc.mainnet.chain.robinhood.com` | `eth_blockNumber` and `eth_getTransactionCount` for the factory (the list); `eth_getBlockByNumber`, `eth_getCode`, `eth_getStorageAt` and `eth_call` with the token's address (one token). |
| | Chainlink's feed directory (`reference-data-directory.vercel.app`) | One download of the directory, for one token's feed address. No token address is sent. |
| `runs` | the Hyvo API (default `api.hyvo.run`) | A request for the list of runs. |
| `verify`, MCP `verify_run` | the Hyvo API | The run id: `GET /v1/runs/:runId/artifact` for a short-lived download link to the `run.json` (on the API's host), that link, and `GET /v1/runs/:runId` for the API's record of the commit. Not asked when you give a file. |
| | the JSON-RPC endpoint | `eth_chainId`, and one `eth_call` of `getCommit` on HyvoOracle with the run id. |

Every request is HTTPS unless you give an `http://` URL, and the requests above are all there are: `check` prints how
many it made and to which hosts. Like any server, each destination sees your IP address.
hyvo sends no analytics or telemetry, and nothing about you: no wallet, no key, no account. It never signs and never
sends a transaction. On disk it writes only the two files in the settings folder, and only when you ask.

## Limits

- A check reads one block. A later block can differ, and a token can behave differently for other senders, other
  amounts or other dates. The simulation sends from a fresh address with no history.
- Venues the simulation does not cover yet are named in the `venue` finding: Uniswap V4 pools outside Pons, Pons
  launches quoted in USDG, and Pons launches between their curve and their V4 pool.
- Without a Blockscout key, the top holders are skipped, and the deployer is read from Pons records and Sourcify only.
- `launches` counts what the factory announced in the window and reads the curves of the newest `--limit` only. Its
  phase for a listed launch is the curve's own `graduated()`; one launch's page reads the factory's record, which also
  tells a curve emptied and waiting for its pool. A busy public endpoint can refuse; `--rpc` takes your own.
- `stocks` lists the tokens up to the scan's block. A token deployed since is read by its address, and a multiplier
  change since the scan shows in the live values but not in the history.
- `runs` and `verify` read the API with the run formats of this version of hyvo. When the API answers in a shape this
  version does not know, they say so; a newer hyvo reads it.

## Development

In the Hyvo repository (filter by path: the workspace root is also named `hyvo`):

```sh
pnpm --filter ./packages/cli typecheck   # tsc over src and test
pnpm --filter ./packages/cli test        # vitest; the network is stubbed
pnpm --filter ./packages/cli build       # typecheck, then esbuild to dist/
node packages/cli/dist/index.js check 0x…
```

`@hyvo/check`, `@hyvo/launches`, `@hyvo/sdk`, `@hyvo/schema` and `@hyvo/stocks` are private workspace packages that
export TypeScript source, so the build compiles them into `dist/` with esbuild, and the published package installs
nothing else. The commands that use the API, and `launches` and `stocks`, load their code only when they run.

## License

hyvo is free software under the GNU Affero General Public License, version 3 or later ([`LICENSE`](LICENSE)).
`dist/` includes code from Aleph (MIT), zod (MIT), @noble/hashes (MIT), canonicalize (Apache-2.0), viem (MIT), ox
(MIT), abitype (MIT) and @noble/curves (MIT); their licenses are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Check, launches and stocks results: Measured on-chain at block N. Not a trading signal.
Run results: Synthetic crowd reaction. Not a trading signal.
