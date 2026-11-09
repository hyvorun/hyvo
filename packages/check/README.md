# @hyvo/check

Hyvo Check reads a token on Robinhood Chain (chain 4663) at one block and returns facts, each with its
evidence: who owns it, whether it is a proxy, which owner-style functions its code exposes, where it trades,
and what happens when someone buys it, sends it on and sells it. That last part is an exit simulation inside a
single read-only `eth_call`. Nothing is signed, approved or sent, and no key is ever involved.

- Zero runtime dependencies. Runs unchanged in browsers, Node 18+ and Cloudflare Workers (no Node modules,
  no `AbortSignal.any`; it is exercised under workerd as well as Node).
- Every finding carries evidence: a function and its selector, an address, a number, or the reason the check
  could not run. A check that cannot run says `skipped`; it is never dropped and never passed.
- Reports state facts. They never give a verdict about a token, never advise anyone to trade, and never
  predict a price. Every surface that shows a report carries `CHECK_NOTICE`:
  "Facts read from Robinhood Chain at one block, each with its evidence. Not a trading signal, and not an audit."

## Use

```ts
import { CHECKS, checkToken, serializeReport } from "@hyvo/check";

const report = await checkToken("0x8eee67a8aad993f15b4506975b38c52f6d3ce758");
for (const f of report.findings) console.log(CHECKS[f.id].title, f.status, f.evidence);
console.log(report.exit?.roundTrip); // { spent, back, lossPct } or null
const json = JSON.stringify(serializeReport(report)); // bigints as decimal strings
```

From the workspace: `"@hyvo/check": "workspace:*"`. The package exports TypeScript source (`src/index.ts`),
which bundlers and runners such as Vite, vitest (in Node and in workerd) and tsx consume as is; a published CLI
bundles it. Its JSON import uses the standard `with { type: "json" }` attribute.

To try real tokens from a terminal (read-only):

```sh
pnpm --filter @hyvo/check check 0x8eee67a8aad993f15b4506975b38c52f6d3ce758 [--eth-in 0.001] [--rpc <url>] [--json]
```

## `checkToken(address, options?) → Promise<CheckReport>`

| Option | Default | Meaning |
|---|---|---|
| `rpcUrls` | `["https://robinhood.drpc.org"]` | JSON-RPC endpoints, tried in order; the list is tried twice. |
| `rpcAttempts` | every URL twice | Requests one JSON-RPC call may send at most, across `rpcUrls`. Hyvo's API sets 3 to stay inside a Cloudflare Worker's subrequest limit. |
| `fetch` | `globalThis.fetch` | Any fetch with the shape of `FetchLike`. |
| `signal` | none | Aborts every request; the promise rejects with `CheckError("aborted")`. |
| `sourcifyUrl` | `https://sourcify.dev/server` | Sourcify server for verified source, ABIs and deployments. |
| `blockscoutKey` | none | A Blockscout API key. Without one, Blockscout is never called. |
| `blockscoutUrl` | `https://api.blockscout.com/4663/api` | Blockscout's keyed API. |
| `holders` | none | `(token, signal) => Promise<HolderFacts \| null>`: holders and the creator read elsewhere, such as through Hyvo's API (`GET /v1/check/:token/holders`, whose answer `parseHolderFacts` reads). It takes the place of Blockscout's holder and creator reads; the evidence names its `source`, not read at the block. `readHolderFacts` reads them from Blockscout with a key. |
| `ethIn` | `10n ** 15n` (0.001 ETH) | What the exit simulation buys with, in wei (1 wei to 1000 ETH). |
| `block` | head − 2 | The block to read at. Two below the head, so every node behind a load balancer has it. |
| `timeoutMs` | `10000` | Limit per request. |

### The report

| Field | Type | |
|---|---|---|
| `chainId` | `number` | 4663, read from the RPC; any other chain is refused. |
| `token` | `{ address, name, symbol, decimals, totalSupply }` | Text from the token, cleaned of control characters; `null` where the token does not answer. |
| `block` | `bigint` | The block every read and the simulation ran at. |
| `findings` | `Finding[]` | One per check, in the order below: `{ id, title, status, evidence }`. |
| `exit` | `ExitSimulation \| null` | The simulation, or `null` when no venue it covers was found or it could not run (the `sell-simulation` finding says why). |
| `code` | `CodeFacts` | Code size, proxy implementation, `owner()`, Sourcify match. |
| `timings` | `Timings` | `totalMs`, `chainMs`, `simulationMs`, `sourcesMs`, and HTTP `requests` by destination. |
| `notice` | `string` | `CHECK_NOTICE`. |

`status` is `found` (the check found what it looks for), `not_found` (it looked, and the evidence says where),
or `skipped` (it could not look, and the evidence says why). `CHECKS[id].looksFor` says what each check looks for:

| id | Title | Looks for | Read from |
|---|---|---|---|
| `source` | Verified source | Verified source for the code that runs (the implementation, for a proxy) | Sourcify; Blockscout with a key |
| `owner` | Owner address | An address other than zero from `owner()` or `getOwner()` | the chain |
| `proxy` | Proxy | An EIP-1967 implementation or beacon slot, or an EIP-1167 clone; and `upgradeTo` in the implementation | the chain |
| `mint` | Mint function | A state-changing `mint`, `mintTo`, `increaseSupply` and similar | verified ABI, else the bytecode's dispatcher |
| `fee-setter` | Fee or tax setter | `setFee`, `setTaxes`, `setSellTax` and similar | same |
| `blocklist` | Address blocklist | `blacklist`, `setBlocked`, `freeze(address)` and similar | same |
| `pause` | Pause or trading switch | `pause`, `setTradingEnabled`, `enableTrading` and similar | same |
| `venue` | Trading venue | Where the token trades against ETH | Pons factories, Uniswap factories, the V4 PoolManager |
| `sell-simulation` | Sell or transfer shortfall | After the buy: a transfer or sell that reverts, or any step short of the venue's own math (a buy that reverts is `skipped`) | the probe, in one `eth_call` |
| `holders` | Top holders | The share of the 10 largest holders, burn addresses and pools left out | Blockscout (needs a key) |
| `deployer` | Deployer | Who created or launched the token | the Pons factories' records, Sourcify, Blockscout |

For the function checks, a verified ABI is authoritative. Without one, the selectors of a fixed list of
signatures are looked for in the dispatcher (`PUSH4 <selector>`); a function under another name is not found,
and the evidence lists exactly what was looked for. The evidence states the owner next to a function and never
claims who can call it: access control is not resolved.

### `checkToken` throws only when no report can be made

`CheckError` with `code`: `invalid_address`, `wrong_chain`, `rpc` (every endpoint failed), `not_a_contract`,
`not_a_token` (neither `totalSupply()` nor `balanceOf(address)` answers), `aborted`.

## The exit simulation

The probe `chain/src/probes/SellCheck.sol` is never deployed. One `eth_call` places its runtime code at the
throwaway address `PROBE_ADDRESS` through a state override, with made-up ETH, and the probe:

1. buys the token with `ethIn` through the venue and records what the venue's own math promised and what
   arrived;
2. sends a tenth of what arrived to a fresh address and records what arrived there;
3. sells the rest back and records the promise and the payout (ETH, or WETH on Uniswap V3 and on V4 pools
   quoted in WETH).

A step counts as short when more than `SHORTFALL_TOLERANCE_PCT` (0.01%) is missing. The promise already
includes the venue's published fees: the router's quote on V2, QuoterV2's on V3, the swap delta on V4, and on
a Pons curve the constant-product math after its fee, creator tax and current snipe tax. A shortfall therefore
means something beyond the venue's own fees, such as a token that taxes transfers. `roundTrip` compares the
ETH the sold part cost at the buy's average price with what came back.

Venues, in this order:

1. A Pons v2 launch (`getLaunchedToken` on the Pons v2 factory): its bonding curve while in phase 0, its
   Uniswap V4 pool with the Pons hook once graduated. Only launches quoted in ETH (or WETH for V4) are traded.
2. A Uniswap V2 pair with WETH that holds reserves.
3. The Uniswap V3 pool with WETH (fee tiers 0.01%, 0.05%, 0.3%, 1%) with the most in-range liquidity.
4. A Uniswap V4 pool outside Pons is reported (the PoolManager holds the token) and not simulated yet.

The factories are read from the routers on every check (`Router02.factory()`, `SwapRouter02.factory()`), and
the Pons hook and PoolManager from the Pons v2 factory. Every address and its source:
`docs/OPEN_ITEMS.md`, "Hyvo Check: addresses and limits", and `ADDRESSES` in `src/registry/addresses.ts`.

## Requests

A check makes 7 to 10 JSON-RPC requests (the reads go through Uniswap's `UniswapInterfaceMulticall` in three
batches), 1 Sourcify request (2 for a proxy), and with a key 4 Blockscout requests (5 for a proxy). That fits
the 50 subrequests a Cloudflare Worker on the free plan may make per request.

## Limits

- One block: a later block can differ, and a token can change its behavior for later blocks, other senders,
  other amounts or other dates. The simulation sends from a fresh address with no history.
- Not covered by the simulation yet: V4 pools outside Pons, Pons launches quoted in another token (USDG),
  Pons launches between their curve and their V4 pool, pools quoted in anything but ETH or WETH.
- Proxies are followed through EIP-1967 (implementation and beacon) and EIP-1167. Other patterns, and contracts
  that route calls through facets or modules, can run functions that are not in their ABI or dispatcher.
- Holders need a Blockscout key: `robinhoodchain.blockscout.com` answers programs with a bot challenge, and the
  keyed API answers 402 without a key. Its routes have not been tried on the keyed host yet.
- Near graduation a Pons curve can fill a buy only in part, which shows as a buy shortfall.

## Maintaining the probe

After editing `chain/src/probes/SellCheck.sol`:

```sh
cd chain && forge build && forge test --match-path "test/probes/*" && node scripts/export-probe.mjs
```

`test/probe.test.ts` fails when `src/probe/sellcheck.json` no longer matches the Solidity source, and, when
`chain/out` exists, when its bytecode or ABI differ from forge's build.

## Tests

`pnpm --filter @hyvo/check test` and `pnpm --filter @hyvo/check typecheck` (the source alone, without Node
types, then the tests). The tests need no network: `test/fake-chain.ts` answers JSON-RPC and Sourcify.

## Third-party notice

Most of `src/chain/` and `src/checks/` is ported from Aleph (`aleph-cli`), the founder's own read-only CLI for
Robinhood Chain, released under the MIT License:

```
MIT License

Copyright (c) 2026 Aleph

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
