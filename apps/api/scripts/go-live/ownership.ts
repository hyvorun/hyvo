/**
 * Moves PaymentRouter's treasury and both contracts' ownership from the deployer wallet to the founder's
 * (docs/OPEN_ITEMS.md item 12, docs/RUNBOOK.md "Launch day"). The CLI is scripts/move-ownership.ts; this module
 * takes its paths as arguments, so a test can point it at a local anvil.
 *
 * A dry run reads the state and estimates the gas. With `send` it loads DEPLOYER_PRIVATE_KEY from the env file at
 * run time, never prints it, checks that it is the deployer the deployment file names, and sends the calls that
 * are still needed one at a time, each after the last one's receipt. Both contracts are Ownable2Step, so nothing
 * changes hands until the founder's wallet calls acceptOwnership() on each.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  fallback,
  formatEther,
  formatGwei,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addressUrl, ORACLE_ABI, parseDeployment, ROUTER_ABI, same } from "./contracts";

export const OWNERSHIP_USAGE = `Usage: pnpm --filter @hyvo/api move-ownership -- --founder <wallet> [--send]

  --founder <address>   the wallet the founder launched HYVO from
  --send                send the transactions with the deployer key in chain/.env (only with the founder's approval)
  --rpc <url,url>       instead of RPC_URLS in apps/api/production.vars.json`;

export interface OwnershipArgs {
  founder: Address;
  send: boolean;
  rpcUrls: string[] | null;
}

export function parseOwnershipArgs(argv: readonly string[]): { ok: true; args: OwnershipArgs } | { ok: false; error: string } {
  let founder = "";
  let send = false;
  let rpc: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--send") send = true;
    else if (arg === "--founder" || arg === "--rpc") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} needs a value` };
      if (arg === "--founder") founder = value.trim();
      else rpc = value;
    } else if (arg.startsWith("--founder=")) founder = arg.slice("--founder=".length).trim();
    else if (arg.startsWith("--rpc=")) rpc = arg.slice("--rpc=".length);
    else return { ok: false, error: `unknown argument: ${arg}` };
  }
  if (!isAddress(founder, { strict: false }) || founder.toLowerCase() === zeroAddress) return { ok: false, error: "--founder must be the founder's wallet address" };
  const rpcUrls = rpc === null ? null : split(rpc);
  return { ok: true, args: { founder: getAddress(founder), send, rpcUrls } };
}

function split(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//.test(item));
}

export interface OwnershipDeps {
  /** A file's text, or null when it is missing. */
  read(path: string): string | null;
  log(line?: string): void;
  paths: { deployment: string; productionVars: string; envFile: string };
  /** How the env file is named in messages. */
  envFileName?: string;
}

interface State {
  treasury: Address;
  routerOwner: Address;
  routerPending: Address;
  oracleOwner: Address;
  oraclePending: Address;
}

interface Call {
  label: string;
  to: Address;
  data: Hex;
  /** The contract's owner now: only it can send the call. */
  owner: Address;
  done: (state: State) => boolean;
  now: (state: State) => string;
}

/** DEPLOYER_PRIVATE_KEY from a .env file's text. The value never leaves this function except as the key itself. */
export function deployerKey(envText: string): Hex | null {
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?DEPLOYER_PRIVATE_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1]!.replace(/^(['"])(.*)\1$/, "$2").trim();
    const hex = value.startsWith("0x") ? value : `0x${value}`;
    return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex as Hex) : null;
  }
  return null;
}

function none(address: Address): string {
  return same(address, zeroAddress) ? "none" : address;
}

async function readState(client: PublicClient, router: Address, oracle: Address): Promise<State> {
  const [treasury, routerOwner, routerPending, oracleOwner, oraclePending] = await Promise.all([
    client.readContract({ address: router, abi: ROUTER_ABI, functionName: "treasury" }),
    client.readContract({ address: router, abi: ROUTER_ABI, functionName: "owner" }),
    client.readContract({ address: router, abi: ROUTER_ABI, functionName: "pendingOwner" }),
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "owner" }),
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "pendingOwner" }),
  ]);
  return { treasury, routerOwner, routerPending, oracleOwner, oraclePending };
}

/** Returns the exit code: 0 done (or a clean dry run), 1 refused or failed. */
export async function moveOwnership(args: OwnershipArgs, deps: OwnershipDeps): Promise<number> {
  const { log, paths } = deps;
  const envName = deps.envFileName ?? paths.envFile;
  const deploymentText = deps.read(paths.deployment);
  if (deploymentText === null) throw new Error(`${paths.deployment} is missing`);
  const deployment = parseDeployment(deploymentText);
  const varsText = deps.read(paths.productionVars);
  const vars = varsText === null ? {} : (JSON.parse(varsText) as Record<string, string>);
  const urls = args.rpcUrls ?? split(vars.RPC_URLS);
  if (urls.length === 0) throw new Error("no RPC endpoint: RPC_URLS in apps/api/production.vars.json is empty and --rpc was not given");

  const chain = defineChain({
    id: deployment.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });
  const transport = urls.length === 1 ? http(urls[0]) : fallback(urls.map((url) => http(url)));
  const client = createPublicClient({ chain, transport, pollingInterval: 500 });
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    log(`REFUSED: the RPC answers for chain ${chainId}, not ${deployment.chainId}. Nothing was sent.`);
    return 1;
  }
  const router = getAddress(deployment.paymentRouter);
  const oracle = getAddress(deployment.oracle);
  const deployer = getAddress(deployment.deployer);
  const founder = args.founder;
  const before = await readState(client, router, oracle);
  const block = await client.getBlockNumber();

  const calls: Call[] = [
    {
      label: `PaymentRouter.setTreasury(${founder})`,
      to: router,
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "setTreasury", args: [founder] }),
      owner: before.routerOwner,
      done: (state) => same(state.treasury, founder),
      now: (state) => `treasury ${state.treasury}`,
    },
    {
      label: `PaymentRouter.transferOwnership(${founder})`,
      to: router,
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "transferOwnership", args: [founder] }),
      owner: before.routerOwner,
      done: (state) => same(state.routerOwner, founder) || same(state.routerPending, founder),
      now: (state) => `owner ${state.routerOwner}, pending owner ${none(state.routerPending)}`,
    },
    {
      label: `HyvoOracle.transferOwnership(${founder})`,
      to: oracle,
      data: encodeFunctionData({ abi: ORACLE_ABI, functionName: "transferOwnership", args: [founder] }),
      owner: before.oracleOwner,
      done: (state) => same(state.oracleOwner, founder) || same(state.oraclePending, founder),
      now: (state) => `owner ${state.oracleOwner}, pending owner ${none(state.oraclePending)}`,
    },
  ];

  log(`Move the treasury and ownership to the founder's wallet ${founder}${args.send ? "" : ": dry run"}`);
  log(`Read on chain ${chainId} at block ${block}. PaymentRouter ${router}, HyvoOracle ${oracle}, deployer ${deployer}.`);
  log();
  const pending = calls.filter((call) => !call.done(before));
  const blocked = pending.filter((call) => !same(call.owner, deployer));
  let totalGas = 0n;
  for (const [index, call] of calls.entries()) {
    log(`  ${index + 1}. ${call.label}`);
    log(`     now: ${call.now(before)}`);
    if (call.done(before)) {
      log("     done already");
    } else if (!same(call.owner, deployer)) {
      log(`     cannot come from the deployer: the contract's owner is ${call.owner}`);
    } else {
      try {
        const gas = await client.estimateGas({ account: deployer, to: call.to, data: call.data });
        totalGas += gas;
        log(`     to send from the deployer, about ${gas.toLocaleString("en-US")} gas`);
      } catch (error) {
        log(`     to send, but the gas estimate failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      }
    }
  }
  log();
  if (pending.length === 0) {
    log("Nothing to send: the treasury is the founder's wallet and both contracts name it as owner or pending owner.");
    founderSteps(log, before, router, oracle, founder);
    return 0;
  }
  const [gasPrice, balance] = await Promise.all([client.getGasPrice(), client.getBalance({ address: deployer })]);
  const cost = totalGas * gasPrice;
  log(
    `Gas: about ${totalGas.toLocaleString("en-US")} in all at ${formatGwei(gasPrice)} gwei, ${formatEther(cost)} ETH. ` +
      `The deployer holds ${formatEther(balance)} ETH${balance < cost * 2n ? ", which may not be enough" : ""}.`,
  );
  if (blocked.length > 0) {
    log(`REFUSED: ${blocked.length} of these calls cannot come from the deployer, whose key this script holds. Nothing was sent.`);
    return 1;
  }
  if (!args.send) {
    log();
    log(`Dry run: nothing was sent. With the founder's approval: pnpm --filter @hyvo/api move-ownership -- --founder ${founder} --send`);
    return 0;
  }

  // --- send -------------------------------------------------------------------------------------------
  const envText = deps.read(paths.envFile);
  if (envText === null) {
    log(`REFUSED: ${envName} is missing, so there is no deployer key. Nothing was sent.`);
    return 1;
  }
  const key = deployerKey(envText);
  if (!key) {
    log(`REFUSED: ${envName} has no DEPLOYER_PRIVATE_KEY of 32 bytes in hex. Nothing was sent.`);
    return 1;
  }
  const account = privateKeyToAccount(key);
  if (!same(account.address, deployer)) {
    log(`REFUSED: the key in ${envName} belongs to ${account.address}, not to the deployer ${deployer} the deployment file names. Nothing was sent.`);
    return 1;
  }
  const wallet = createWalletClient({ account, chain, transport });
  log();
  for (const call of pending) {
    const current = await readState(client, router, oracle);
    if (call.done(current)) {
      log(`  ${call.label}: done already`);
      continue;
    }
    try {
      const hash = await wallet.sendTransaction({ to: call.to, data: call.data });
      log(`  ${call.label}: sent ${hash}`);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`the transaction ${hash} reverted in block ${receipt.blockNumber}`);
      log(`     confirmed in block ${receipt.blockNumber}, ${receipt.gasUsed.toLocaleString("en-US")} gas`);
    } catch (error) {
      // An RPC can refuse a transaction that already went through ("already known", "nonce too low"): trust the chain.
      const after = await readState(client, router, oracle);
      if (!call.done(after)) {
        log(`FAILED at ${call.label}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
        log("Run the same command again: calls that went through are skipped.");
        return 1;
      }
      log(`     the chain shows it went through`);
    }
  }

  const after = await readState(client, router, oracle);
  log();
  log("Read back from the chain:");
  for (const call of calls) log(`  ${call.done(after) ? "ok    " : "FAILED"} ${call.label.replace(/\(.*\)$/, "")}: ${call.now(after)}`);
  if (!calls.every((call) => call.done(after))) return 1;
  founderSteps(log, after, router, oracle, founder);
  return 0;
}

function founderSteps(log: (line?: string) => void, state: State, router: Address, oracle: Address, founder: Address): void {
  const open = [
    { name: "PaymentRouter", address: router, owner: state.routerOwner },
    { name: "HyvoOracle", address: oracle, owner: state.oracleOwner },
  ].filter((contract) => !same(contract.owner, founder));
  log();
  if (open.length === 0) {
    log("The founder's wallet owns both contracts. Next: token:go-live with --open-payments (docs/RUNBOOK.md, \"Launch day\").");
    return;
  }
  log(`The founder now calls acceptOwnership() from ${founder}, on the Write tab of each verified contract on Blockscout:`);
  for (const contract of open) log(`  - ${contract.name}: ${addressUrl(contract.address)}`);
  log("Nothing changes hands until he does. Payments need only the treasury, which has moved; the ownership is for");
  log("setTokenAllowed, setTreasury and the attester later on. Then: token:go-live with --open-payments.");
}
