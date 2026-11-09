/**
 * Builds src/snapshot.json from the chain alone, read-only:
 *
 * 1. Every token the StockFactory deployed. A CREATE2 raises the factory's nonce by one, so the
 *    blocks where its nonce went up are found by bisection over the nonce at past blocks, and the
 *    factory's `Deployed(uid, token, name, symbol)` event is read from each of those blocks.
 * 2. Every multiplier and name change of each token. `effectiveAt()`, `newUIMultiplier()`,
 *    `name()` and `symbol()` are read for all tokens at once on a grid of past blocks (Multicall3);
 *    where a token's values differ between two reads, bisection finds the block of each change, and
 *    its `UIMultiplierUpdated` and `MetaDataUpdated` events are read from that block.
 *
 * Bisection replaces a log search because dRPC's free tier answers `eth_getLogs` over a few hundred
 * blocks at most (docs/OPEN_ITEMS.md item 3). It needs old state, which the free tier serves on and
 * off (item 25); the client retries until a node has it.
 *
 * Usage: pnpm --filter @hyvo/stocks scan   (RH_RPC_URL overrides the RPC)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  multicall3Abi,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { CHAIN_ID, FACTORY_ABI, FACTORY_DEPLOY_BLOCK, MULTICALL3, STOCK_ABI, STOCK_FACTORY } from "../src/contracts";
import type { MetadataUpdate, MultiplierUpdate, Snapshot, SnapshotToken } from "../src/snapshot";
import { hex, rpcClient } from "./rpc";

const rpc = rpcClient();
const GRID = 200;
const CHUNK = 60;

const DEPLOYED = toEventSelector("Deployed(bytes32,address,string,string)");
const MULTIPLIER_UPDATED = toEventSelector("UIMultiplierUpdated(uint256,uint256,uint256)");
const METADATA_UPDATED = toEventSelector("MetaDataUpdated(string,string)");

interface Log {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

const blockTimes = new Map<number, string>();
async function blockTime(block: number): Promise<string> {
  const known = blockTimes.get(block);
  if (known) return known;
  const header = await rpc.request<{ timestamp: Hex }>("eth_getBlockByNumber", [hex(block), false]);
  const time = new Date(Number(BigInt(header.timestamp)) * 1000).toISOString().replace(".000Z", "Z");
  blockTimes.set(block, time);
  return time;
}

// --- 1. the factory's deployments -------------------------------------------------------------

async function factoryNonce(block: number): Promise<number> {
  return Number(BigInt(await rpc.request<Hex>("eth_getTransactionCount", [STOCK_FACTORY, hex(block)])));
}

/** Blocks in (lo, hi] where the nonce rose, with how much. */
async function nonceSteps(lo: number, hi: number, nLo: number, nHi: number, out: { block: number; count: number }[]): Promise<void> {
  if (nLo === nHi) return;
  if (hi - lo === 1) {
    out.push({ block: hi, count: nHi - nLo });
    return;
  }
  const mid = Math.floor((lo + hi) / 2);
  const nMid = await factoryNonce(mid);
  if (nMid < nLo || nMid > nHi) throw new Error(`the factory's nonce went down between blocks ${lo} and ${hi}`);
  await Promise.all([nonceSteps(lo, mid, nLo, nMid, out), nonceSteps(mid, hi, nMid, nHi, out)]);
}

// --- 2. state reads at past blocks ------------------------------------------------------------

const STATE_FUNCTIONS = ["effectiveAt", "newUIMultiplier", "name", "symbol"] as const;
type State = { effectiveAt: bigint; newUIMultiplier: bigint; name: string; symbol: string };
const key = (state: State) => `${state.effectiveAt}|${state.newUIMultiplier}|${state.name}|${state.symbol}`;

/** effectiveAt, newUIMultiplier, name and symbol of each token at `block`, in one Multicall3 call per chunk. */
async function statesAt(block: number, tokens: Address[]): Promise<Map<Address, State>> {
  const out = new Map<Address, State>();
  for (let start = 0; start < tokens.length; start += CHUNK) {
    const chunk = tokens.slice(start, start + CHUNK);
    const calls = chunk.flatMap((target) =>
      STATE_FUNCTIONS.map((functionName) => ({ target, allowFailure: true, callData: encodeFunctionData({ abi: STOCK_ABI, functionName }) })),
    );
    const data = encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });
    const raw = await rpc.request<Hex>("eth_call", [{ to: MULTICALL3, data }, hex(block)]);
    const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: raw });
    chunk.forEach((token, i) => {
      const values = STATE_FUNCTIONS.map((functionName, j) => {
        const result = results[i * STATE_FUNCTIONS.length + j]!;
        if (!result.success) throw new Error(`${functionName}() failed on ${token} at block ${block}`);
        return decodeFunctionResult({ abi: STOCK_ABI, functionName, data: result.returnData });
      });
      out.set(token, {
        effectiveAt: values[0] as bigint,
        newUIMultiplier: values[1] as bigint,
        name: values[2] as string,
        symbol: values[3] as string,
      });
    });
  }
  return out;
}

async function stateAt(block: number, token: Address): Promise<State> {
  return (await statesAt(block, [token])).get(token)!;
}

/** Blocks in (lo, hi] where the token's state changed. */
async function changes(token: Address, lo: number, hi: number, kLo: string, kHi: string, out: number[]): Promise<void> {
  if (kLo === kHi) return;
  if (hi - lo === 1) {
    out.push(hi);
    return;
  }
  const mid = Math.floor((lo + hi) / 2);
  const kMid = key(await stateAt(mid, token));
  await Promise.all([changes(token, lo, mid, kLo, kMid, out), changes(token, mid, hi, kMid, kHi, out)]);
}

// --- 3. the scan ---------------------------------------------------------------------------------

async function main() {
  const latest = Number(BigInt(await rpc.request<Hex>("eth_blockNumber", [])));
  // A little behind the tip, so that every node asked has the block.
  const head = latest - 50;
  const nonceAtHead = await factoryNonce(head);
  console.log(`head ${head}, factory nonce ${nonceAtHead}`);

  // Split the range first so the bisection runs in parallel.
  const parts = 16;
  const edges = Array.from({ length: parts + 1 }, (_, i) => FACTORY_DEPLOY_BLOCK - 1 + Math.floor(((head - FACTORY_DEPLOY_BLOCK + 1) * i) / parts));
  const nonces = await Promise.all(edges.map((edge) => (edge < FACTORY_DEPLOY_BLOCK ? Promise.resolve(0) : factoryNonce(edge))));
  const steps: { block: number; count: number }[] = [];
  await Promise.all(edges.slice(0, -1).map((lo, i) => nonceSteps(lo, edges[i + 1]!, nonces[i]!, nonces[i + 1]!, steps)));
  steps.sort((a, b) => a.block - b.block);
  console.log(`nonce rose in ${steps.length} blocks (${rpc.calls} calls)`);

  const deployed: SnapshotToken["deployed"][] = [];
  const tokens: { address: Address; uid: Hex; deployed: SnapshotToken["deployed"] }[] = [];
  await Promise.all(
    steps.map(async ({ block, count }) => {
      const logs = await rpc.request<Log[]>("eth_getLogs", [{ address: STOCK_FACTORY, topics: [DEPLOYED], fromBlock: hex(block), toBlock: hex(block) }]);
      // The factory's own creation raised its nonce from 0 to 1 in its deploy block.
      const expected = block === FACTORY_DEPLOY_BLOCK ? count - 1 : count;
      if (logs.length !== expected) throw new Error(`block ${block}: the nonce rose by ${count} but ${logs.length} Deployed events were found`);
      for (const log of logs) {
        const event = decodeEventLog({ abi: FACTORY_ABI, eventName: "Deployed", topics: log.topics as [Hex, ...Hex[]], data: log.data });
        const entry = { block, time: await blockTime(block), tx: log.transactionHash, name: event.args.name, symbol: event.args.symbol };
        deployed.push(entry);
        tokens.push({ address: getAddress(event.args.token), uid: event.args.uid, deployed: entry });
      }
    }),
  );
  tokens.sort((a, b) => a.deployed.block - b.deployed.block || a.address.localeCompare(b.address));
  console.log(`${tokens.length} tokens deployed (${rpc.calls} calls)`);

  // The state of each token right after its deployment, then on a grid of blocks up to the head.
  const first = new Map<Address, State>();
  await Promise.all(tokens.map(async (token) => first.set(token.address, await stateAt(token.deployed.block, token.address))));
  const start = tokens[0]!.deployed.block;
  const grid = Array.from({ length: GRID }, (_, i) => start + Math.ceil(((head - start) * (i + 1)) / GRID));
  const gridStates = new Map<number, Map<Address, State>>();
  await Promise.all(
    grid.map(async (block) => {
      const alive = tokens.filter((token) => token.deployed.block < block).map((token) => token.address);
      gridStates.set(block, alive.length ? await statesAt(block, alive) : new Map());
    }),
  );
  console.log(`grid read (${rpc.calls} calls)`);

  const result: SnapshotToken[] = [];
  await Promise.all(
    tokens.map(async (token) => {
      const points: { block: number; state: State }[] = [{ block: token.deployed.block, state: first.get(token.address)! }];
      for (const block of grid) {
        const state = gridStates.get(block)!.get(token.address);
        if (state) points.push({ block, state });
      }
      const changed: number[] = [];
      for (let i = 1; i < points.length; i++) {
        await changes(token.address, points[i - 1]!.block, points[i]!.block, key(points[i - 1]!.state), key(points[i]!.state), changed);
      }
      changed.sort((a, b) => a - b);

      const multiplierUpdates: MultiplierUpdate[] = [];
      const metadataUpdates: MetadataUpdate[] = [];
      // An update in the deploy block itself shows as a first state different from a fresh token's.
      const fresh = points[0]!.state;
      const blocks = fresh.effectiveAt !== 0n || fresh.name !== token.deployed.name || fresh.symbol !== token.deployed.symbol ? [token.deployed.block, ...changed] : changed;
      for (const block of blocks) {
        const logs = await rpc.request<Log[]>("eth_getLogs", [
          { address: token.address, topics: [[MULTIPLIER_UPDATED, METADATA_UPDATED]], fromBlock: hex(block), toBlock: hex(block) },
        ]);
        if (logs.length === 0) console.warn(`${token.address}: its state changed in block ${block}, but no update event was found there`);
        for (const log of logs.sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)))) {
          const time = await blockTime(block);
          const event = decodeEventLog({ abi: STOCK_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
          if (event.eventName === "UIMultiplierUpdated") {
            multiplierUpdates.push({
              block,
              time,
              tx: log.transactionHash,
              oldMultiplier: event.args.oldMultiplier.toString(),
              newMultiplier: event.args.newMultiplier.toString(),
              effectiveAt: Number(event.args.effectiveAtTimestamp),
            });
          } else if (event.eventName === "MetaDataUpdated") {
            metadataUpdates.push({ block, time, tx: log.transactionHash, name: event.args.name, symbol: event.args.symbol });
          }
        }
      }

      const last = points[points.length - 1]!.state;
      const latestUpdate = multiplierUpdates[multiplierUpdates.length - 1];
      if (latestUpdate && (BigInt(latestUpdate.newMultiplier) !== last.newUIMultiplier || BigInt(latestUpdate.effectiveAt) !== last.effectiveAt)) {
        console.warn(`${token.address}: its last update event does not match its state at block ${head}`);
      }
      result.push({
        address: token.address,
        uid: token.uid,
        symbol: last.symbol,
        name: last.name,
        deployed: token.deployed,
        multiplierUpdates,
        metadataUpdates,
      });
    }),
  );
  result.sort((a, b) => a.deployed.block - b.deployed.block || a.address.localeCompare(b.address));

  const snapshot: Snapshot = {
    version: 1,
    chainId: CHAIN_ID,
    factory: STOCK_FACTORY,
    block: head,
    time: await blockTime(head),
    factoryNonce: nonceAtHead,
    tokens: result,
  };
  const path = fileURLToPath(new URL("../src/snapshot.json", import.meta.url));
  writeFileSync(path, `${JSON.stringify(snapshot, null, 1)}\n`);
  const updates = result.reduce((sum, token) => sum + token.multiplierUpdates.length, 0);
  console.log(`wrote ${path}: ${result.length} tokens, ${updates} multiplier updates, ${rpc.calls} RPC calls`);
}

await main();
