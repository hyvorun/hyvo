/**
 * The HYVO go-live (docs/RUNBOOK.md, "Launch day"): read the founder's token from the chain, check it, and
 * switch the repo's settings to it. The CLI is scripts/token-go-live.ts; this module takes its files and its
 * RPC as arguments, so tests run it on temporary copies and a stubbed chain.
 */
import { formatUnits, getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import {
  addressOrNull,
  addressUrl,
  CHAIN_ID,
  ERC20_ABI,
  EXPLORER,
  FACTORY_ABI,
  ORACLE_ABI,
  parseDeployment,
  PHASES,
  PONS_V2_FACTORY,
  ROUTER_ABI,
  same,
  SITE,
  type LaunchedToken,
} from "./contracts";
import { liveReadmeBlock, patchJson, replaceMarked } from "./files";
import { Rpc, type FetchLike } from "./rpc";

export const USAGE = `Usage: pnpm --filter @hyvo/api token:go-live -- --token <CA> --founder <wallet> --holder-min <whole HYVO> [options]

  --token <address>      the HYVO token's contract address (CA), as the founder sends it
  --founder <address>    the wallet the founder launched it from
  --holder-min <amount>  HOLDER_MIN, in whole HYVO (for example 100000); 0 keeps holder benefits off
  --open-payments        also open paid runs: PaymentRouter's treasury must already be the founder's wallet
  --write                write the changes (without it this is a dry run that changes nothing)
  --force                go on although the Pons V2 factory does not name the founder as the creator
  --verify               after the deploy: check that the live API has switched
  --rpc <url,url>        read through these endpoints instead of RPC_URLS in apps/api/production.vars.json`;

export interface GoLiveArgs {
  token: Address;
  founder: Address;
  /** HOLDER_MIN in whole HYVO, normalized ("100000", "2.5"). */
  holderMin: string;
  openPayments: boolean;
  write: boolean;
  force: boolean;
  verify: boolean;
  rpcUrls: string[] | null;
}

export function parseArgs(argv: readonly string[]): { ok: true; args: GoLiveArgs } | { ok: false; error: string } {
  const flags = new Set(["--open-payments", "--write", "--force", "--verify"]);
  const valued = new Set(["--token", "--founder", "--holder-min", "--rpc"]);
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue; // pnpm passes the separator through
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flags.has(name)) {
      seen.add(name);
    } else if (valued.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${name} needs a value` };
      values.set(name, value.trim());
    } else {
      return { ok: false, error: `unknown argument: ${arg}` };
    }
  }
  const token = values.get("--token") ?? "";
  const founder = values.get("--founder") ?? "";
  const holderMin = values.get("--holder-min") ?? "";
  if (!isAddress(token, { strict: false }) || token.toLowerCase() === zeroAddress) return { ok: false, error: "--token must be the token's contract address" };
  if (!isAddress(founder, { strict: false }) || founder.toLowerCase() === zeroAddress) return { ok: false, error: "--founder must be the founder's wallet address" };
  if (same(token, founder)) return { ok: false, error: "--token and --founder are the same address" };
  const normalized = normalizeAmount(holderMin);
  if (normalized === null) return { ok: false, error: "--holder-min must be an amount of whole HYVO, such as 100000 or 2.5" };
  const rpc = values.get("--rpc");
  return {
    ok: true,
    args: {
      token: getAddress(token),
      founder: getAddress(founder),
      holderMin: normalized,
      openPayments: seen.has("--open-payments"),
      write: seen.has("--write"),
      force: seen.has("--force"),
      verify: seen.has("--verify"),
      rpcUrls: rpc ? split(rpc) : null,
    },
  };
}

/** "0100" -> "100", "2.50" -> "2.5", "3.0" -> "3"; null for anything that is not a plain decimal amount. */
export function normalizeAmount(text: string): string | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text.trim().replace(/_/g, ""));
  if (!match) return null;
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function split(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//.test(item));
}

/** Reads and writes the three files, by absolute path. `read` is null for a missing file. */
export interface Io {
  read(path: string): string | null;
  write(path: string, text: string): void;
}

export interface Paths {
  deployment: string;
  productionVars: string;
  readme: string;
}

/** How each file is named in the report. */
export const NAMES: Record<keyof Paths, string> = {
  deployment: "chain/deployments/4663.json",
  productionVars: "apps/api/production.vars.json",
  readme: "README.md",
};

export interface Deps {
  io: Io;
  paths: Paths;
  log: (line?: string) => void;
  /** The chain; by default the endpoints in RPC_URLS (or --rpc). */
  rpc?: Rpc;
  /** For the RPC and --verify; by default the global fetch. */
  fetch?: FetchLike;
}

type Level = "ok" | "note" | "warn" | "forced" | "refused";

interface Finding {
  level: Level;
  text: string;
}

interface FileChange {
  file: keyof Paths;
  before: string;
  after: string;
  lines: string[];
}

interface Facts {
  block: bigint;
  host: string;
  code: number;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  record: LaunchedToken | null;
  pairSymbol: string | null;
  router: { owner: Address | null; pendingOwner: Address | null; treasury: Address | null; usdgAllowed: boolean | null } | null;
  oracle: { owner: Address | null; pendingOwner: Address | null } | null;
}

const LABEL: Record<Level, string> = { ok: "ok     ", note: "note   ", warn: "WARNING", forced: "FORCED ", refused: "REFUSED" };

function grouped(value: bigint, decimals: number): string {
  const [whole, fraction] = formatUnits(value, decimals).split(".");
  const withCommas = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${withCommas}.${fraction}` : withCommas;
}

function shown(value: unknown): string {
  return value === undefined || value === null || value === "" ? "(not set)" : String(value);
}

/** Read everything the go-live needs from the chain, at one block. */
async function readChain(rpc: Rpc, args: GoLiveArgs, router: Address, oracle: Address, usdg: Address | null): Promise<Facts> {
  const block = await rpc.blockNumber();
  const code = await rpc.code(args.token, block);
  const read = <T>(address: Address, abi: Parameters<Rpc["read"]>[1], name: string, params: readonly unknown[] = []) => rpc.read<T>(address, abi, name, params, block);
  const [name, symbol, decimals, totalSupply, record] = await Promise.all([
    read<string>(args.token, ERC20_ABI, "name"),
    read<string>(args.token, ERC20_ABI, "symbol"),
    read<number>(args.token, ERC20_ABI, "decimals"),
    read<bigint>(args.token, ERC20_ABI, "totalSupply"),
    read<LaunchedToken>(PONS_V2_FACTORY, FACTORY_ABI, "getLaunchedToken", [args.token]),
  ]);
  const launched = record?.exists && same(record.token, args.token) ? record : null;
  let pairSymbol: string | null = null;
  if (launched) pairSymbol = same(launched.pairToken, zeroAddress) ? "ETH" : await read<string>(launched.pairToken, ERC20_ABI, "symbol");
  let routerState: Facts["router"] = null;
  let oracleState: Facts["oracle"] = null;
  if (args.openPayments) {
    const [owner, pendingOwner, treasury, usdgAllowed, oracleOwner, oraclePending] = await Promise.all([
      read<Address>(router, ROUTER_ABI, "owner"),
      read<Address>(router, ROUTER_ABI, "pendingOwner"),
      read<Address>(router, ROUTER_ABI, "treasury"),
      usdg ? read<boolean>(router, ROUTER_ABI, "allowedToken", [usdg]) : Promise.resolve(null),
      read<Address>(oracle, ORACLE_ABI, "owner"),
      read<Address>(oracle, ORACLE_ABI, "pendingOwner"),
    ]);
    routerState = { owner, pendingOwner, treasury, usdgAllowed };
    oracleState = { owner: oracleOwner, pendingOwner: oraclePending };
  }
  return {
    block,
    host: rpc.lastHost,
    code: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    name: name === null ? null : name.trim(),
    symbol: symbol === null ? null : symbol.trim(),
    decimals: decimals === null ? null : Number(decimals),
    totalSupply,
    record: launched,
    pairSymbol,
    router: routerState,
    oracle: oracleState,
  };
}

/**
 * The go-live itself. Returns the exit code: 0 done (or a clean dry run), 1 refused or failed. Nothing is
 * written unless `args.write`, and nothing at all when a check refuses.
 */
export async function goLive(args: GoLiveArgs, deps: Deps): Promise<number> {
  const { io, paths, log } = deps;
  const texts = {
    deployment: io.read(paths.deployment),
    productionVars: io.read(paths.productionVars),
    readme: io.read(paths.readme),
  };
  if (texts.deployment === null) throw new Error(`${NAMES.deployment} is missing`);
  if (texts.productionVars === null) throw new Error(`${NAMES.productionVars} is missing`);
  const deployment = parseDeployment(texts.deployment);
  const vars = JSON.parse(texts.productionVars) as Record<string, string>;
  const router = getAddress(deployment.paymentRouter);
  const oracle = getAddress(deployment.oracle);
  const usdg = addressOrNull(deployment.usdg);

  const rpc = deps.rpc ?? new Rpc(args.rpcUrls ?? split(vars.RPC_URLS), deps.fetch);
  const chainId = await rpc.chainId();
  if (chainId !== deployment.chainId || chainId !== CHAIN_ID) {
    log(`REFUSED: the RPC answers for chain ${chainId}, not Robinhood Chain (${CHAIN_ID}). Nothing was written.`);
    return 1;
  }
  const facts = await readChain(rpc, args, router, oracle, usdg);
  const findings: Finding[] = [];
  const add = (level: Level, text: string) => findings.push({ level, text });

  log(`HYVO go-live${args.write ? "" : ", dry run"}: read on Robinhood Chain (${CHAIN_ID}) at block ${facts.block} through ${facts.host || "the RPC"}`);
  log();
  log(`Token ${args.token}  ${addressUrl(args.token)}`);
  log(`  code             ${facts.code > 0 ? `${facts.code} bytes` : "none"}`);
  log(`  name, symbol     ${shown(facts.name)}, ${shown(facts.symbol)}`);
  log(`  decimals         ${shown(facts.decimals)}`);
  log(`  total supply     ${facts.totalSupply !== null && facts.decimals !== null ? `${grouped(facts.totalSupply, facts.decimals)} ${facts.symbol ?? ""}`.trim() : "(unreadable)"}`);
  if (facts.record) {
    const record = facts.record;
    log(`Pons V2 record (factory ${PONS_V2_FACTORY})`);
    log(`  creator          ${record.deployer}${same(record.deployer, args.founder) ? "  (the founder's wallet)" : ""}`);
    log(`  fee recipient    ${record.creatorFeeRecipient}${same(record.creatorFeeRecipient, args.founder) ? "  (the founder's wallet)" : ""}`);
    log(`  curve            ${record.curve}`);
    log(`  pair             ${facts.pairSymbol ?? "?"}${same(record.pairToken, zeroAddress) ? "" : ` (${record.pairToken})`}`);
    log(`  creator tax      ${(Number(record.creatorTaxBps) / 100).toFixed(2)}% (${record.creatorTaxBps} bps)`);
    log(`  phase            ${PHASES[Number(record.phase)] ?? `phase ${record.phase}`}`);
  } else {
    log(`Pons V2 record    none: the factory ${PONS_V2_FACTORY} has no launch of this address`);
  }
  if (facts.router && facts.oracle) {
    log(`PaymentRouter ${router}`);
    log(`  treasury         ${shown(facts.router.treasury)}${same(facts.router.treasury, args.founder) ? "  (the founder's wallet)" : ""}`);
    log(`  owner            ${shown(facts.router.owner)}${same(facts.router.owner, args.founder) ? "  (the founder's wallet)" : ""}`);
    log(`  pending owner    ${shown(facts.router.pendingOwner)}`);
    log(`  accepts USDG     ${shown(facts.router.usdgAllowed)}`);
    log(`HyvoOracle ${oracle}`);
    log(`  owner            ${shown(facts.oracle.owner)}${same(facts.oracle.owner, args.founder) ? "  (the founder's wallet)" : ""}`);
    log(`  pending owner    ${shown(facts.oracle.pendingOwner)}`);
  }

  // --- checks ---------------------------------------------------------------------------------------
  const erc20 = facts.name !== null && facts.symbol !== null && facts.decimals !== null && facts.totalSupply !== null;
  if (facts.code === 0) add("refused", `no contract at ${args.token} at block ${facts.block}: this address is not a token`);
  else if (!erc20) add("refused", "the address does not answer name(), symbol(), decimals() and totalSupply() like a token");
  else add("ok", "the address is a token contract");

  if (erc20) {
    if (facts.name === "Hyvo" && facts.symbol === "HYVO") add("ok", "name and symbol are Hyvo and HYVO");
    else add("warn", `name and symbol are "${facts.name}" and "${facts.symbol}", not "Hyvo" and "HYVO": check that this is the right token`);
  }

  if (!facts.record) {
    add(args.force ? "forced" : "refused", `the Pons V2 factory has no launch of ${args.token}${args.force ? "; going on because of --force" : ""}`);
  } else if (!same(facts.record.deployer, args.founder)) {
    add(
      args.force ? "forced" : "refused",
      `the Pons V2 factory names ${facts.record.deployer} as the creator, not the founder's wallet ${args.founder}${args.force ? "; going on because of --force" : ""}`,
    );
  } else {
    add("ok", "the Pons V2 factory names the founder's wallet as the creator");
  }

  let holderUnits = 0n;
  if (erc20) {
    const fraction = args.holderMin.split(".")[1] ?? "";
    if (fraction.length > facts.decimals!) {
      add("refused", `--holder-min ${args.holderMin} has more decimals than the token's ${facts.decimals}`);
    } else {
      holderUnits = parseUnits(args.holderMin, facts.decimals!);
      if (holderUnits === 0n) add("warn", "HOLDER_MIN is 0: holder benefits stay off");
      else if (holderUnits > facts.totalSupply!) add("refused", `--holder-min ${args.holderMin} is more than the total supply: no wallet could hold it`);
      else {
        const share = Number((holderUnits * 1_000_000n) / (facts.totalSupply! || 1n)) / 10_000;
        add("ok", `HOLDER_MIN ${args.holderMin} HYVO is ${share}% of the total supply`);
      }
    }
  }

  if (args.openPayments && facts.router && facts.oracle) {
    if (!same(facts.router.treasury, args.founder)) {
      add(
        "refused",
        `PaymentRouter's treasury is ${shown(facts.router.treasury)}, not the founder's wallet: payments stay closed. Move it first: ` +
          `pnpm --filter @hyvo/api move-ownership -- --founder ${args.founder}`,
      );
    } else {
      add("ok", "PaymentRouter pays the founder's wallet");
    }
    if (facts.router.usdgAllowed !== true) add("refused", `PaymentRouter does not accept USDG (${shown(usdg)}): a payment would revert`);
    for (const [label, state] of [
      ["PaymentRouter", facts.router],
      ["HyvoOracle", facts.oracle],
    ] as const) {
      if (!same(state.owner, args.founder)) {
        add(
          "warn",
          same(state.pendingOwner, args.founder)
            ? `${label}: the founder's wallet still has to call acceptOwnership() (owner ${shown(state.owner)})`
            : `${label}: owned by ${shown(state.owner)}, and the founder's wallet is not its pending owner`,
        );
      }
    }
  } else if (!args.openPayments) {
    add("note", "paid runs stay closed (no --open-payments)");
  }
  if (facts.record && !same(facts.record.creatorFeeRecipient, args.founder)) {
    add("note", `the launch's creator fee recipient is ${facts.record.creatorFeeRecipient}, not the founder's wallet`);
  }

  // --- changes --------------------------------------------------------------------------------------
  const changes: FileChange[] = [];
  const jsonChange = (file: "deployment" | "productionVars", before: string, current: Record<string, unknown>, updates: Record<string, string | number>) => {
    const lines: string[] = [];
    const effective: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (current[key] === value) continue;
      effective[key] = value;
      lines.push(`${key.padEnd(28)} ${shown(current[key])} -> ${value}`);
    }
    if (lines.length > 0) changes.push({ file, before, after: patchJson(before, effective), lines });
  };

  const deploymentJson = JSON.parse(texts.deployment) as Record<string, unknown>;
  const deploymentUpdates: Record<string, string | number> = { hyvoToken: args.token };
  if (facts.router && facts.oracle) {
    if (facts.router.treasury) deploymentUpdates.treasury = facts.router.treasury;
    if (facts.router.owner && same(facts.router.owner, facts.oracle.owner)) deploymentUpdates.owner = facts.router.owner;
  }
  jsonChange("deployment", texts.deployment, deploymentJson, deploymentUpdates);

  const varUpdates: Record<string, string> = {
    HYVO_TOKEN_ADDRESS: args.token,
    HYVO_TOKEN_DECIMALS: String(facts.decimals ?? 18),
    HOLDER_MIN: args.holderMin,
  };
  if (args.openPayments) {
    const keepBlock = same(vars.PAYMENT_ROUTER_ADDRESS, router) && /^[1-9][0-9]*$/.test(vars.PAYMENT_ROUTER_DEPLOY_BLOCK ?? "");
    const admins = [args.founder, ...(vars.ADMIN_ADDRESSES ?? "").split(",").map((item) => addressOrNull(item))].filter(
      (item, index, all): item is Address => item !== null && all.findIndex((other) => same(other, item)) === index,
    );
    Object.assign(varUpdates, {
      PAYMENT_ROUTER_ADDRESS: router,
      // Where the payment scan starts (apps/api/src/lib/payments.ts): the head now, not the deploy block, so the
      // first cron runs do not walk millions of empty blocks 100 at a time.
      PAYMENT_ROUTER_DEPLOY_BLOCK: keepBlock ? vars.PAYMENT_ROUTER_DEPLOY_BLOCK! : String(facts.block),
      TREASURY_ADDRESS: args.founder,
      ADMIN_ADDRESSES: admins.join(","),
    });
  }
  jsonChange("productionVars", texts.productionVars, vars, varUpdates);

  if (texts.readme === null) {
    add("warn", `${NAMES.readme} is missing: left as is`);
  } else {
    const marked = replaceMarked(texts.readme, liveReadmeBlock(args.token, EXPLORER, SITE));
    if (!marked.ok) add("warn", `${NAMES.readme}: ${marked.reason}, so it is left as is`);
    else if (marked.text !== texts.readme) {
      changes.push({ file: "readme", before: texts.readme, after: marked.text, lines: ["the hyvo-token block -> the official address, linked to Blockscout, and hyvo.run/token"] });
    }
  }

  log();
  log("Checks");
  for (const finding of findings) log(`  ${LABEL[finding.level]}  ${finding.text}`);
  if (findings.some((finding) => finding.level === "forced")) {
    log();
    log("  !!! --force is overriding a refusal above. Go on only if the founder has confirmed this address himself. !!!");
  }

  log();
  log(changes.length > 0 ? "Changes" : "Changes: none, the files already say this");
  for (const change of changes) {
    log(`  ${NAMES[change.file]}`);
    for (const line of change.lines) log(`    ${line}`);
  }

  const refused = findings.some((finding) => finding.level === "refused");
  log();
  if (refused) {
    log("REFUSED: nothing was written. Fix what is marked REFUSED above and run this again.");
    return 1;
  }
  if (!args.write) {
    log(`Dry run: nothing was written. Add --write to write ${changes.length > 0 ? "these changes" : "(nothing would change)"}.`);
  } else {
    for (const change of changes) io.write(paths[change.file], change.after);
    log(changes.length > 0 ? `Written: ${changes.map((change) => NAMES[change.file]).join(", ")}.` : "Nothing to write.");
  }

  if (args.verify) return verifyLive(args, vars, holderUnits, deps);

  log();
  log("Next");
  const flags = `--token ${args.token} --founder ${args.founder} --holder-min ${args.holderMin}${args.openPayments ? " --open-payments" : ""}`;
  const steps = [
    ...(args.write ? [] : [`pnpm --filter @hyvo/api token:go-live -- ${flags} --write`]),
    `git diff -- ${Object.values(NAMES).join(" ")}, then commit those files`,
    "pnpm --filter @hyvo/api deploy:cloudflare          (names the account, changes nothing)",
    "pnpm --filter @hyvo/api deploy:cloudflare --yes    (deploys the Worker and the web app with these values)",
    `pnpm --filter @hyvo/api token:go-live -- ${flags} --verify`,
    `open ${SITE}/token (the official address), ${SITE}/trust and ${SITE} on a phone and a laptop`,
    ...(args.openPayments ? [`play one small paid run from ${SITE}/new, then check it on ${SITE}/oracle`] : []),
  ];
  steps.forEach((step, index) => log(`  ${index + 1}. ${step}`));
  return 0;
}

/** After the deploy: does the live API say what the files say? */
async function verifyLive(args: GoLiveArgs, vars: Record<string, string>, holderUnits: bigint, deps: Deps): Promise<number> {
  const { log } = deps;
  const api = (vars.PUBLIC_API_URL ?? "").replace(/\/+$/, "");
  log();
  if (!/^https?:\/\//.test(api)) {
    log(`REFUSED: PUBLIC_API_URL in ${NAMES.productionVars} is not set, so there is no live API to check.`);
    return 1;
  }
  const fetcher: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  let health: {
    ok?: boolean;
    features?: { payments?: boolean; holder?: boolean };
    holder?: { min?: string; decimals?: number; heldForSeconds?: number } | null;
  };
  try {
    const response = await fetcher(`${api}/v1/health`, { method: "GET", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = (await response.json()) as typeof health;
  } catch (error) {
    log(`REFUSED: ${api}/v1/health did not answer (${error instanceof Error ? error.message : String(error)}).`);
    return 1;
  }
  const problems: string[] = [];
  log(`Live API ${api}/v1/health`);
  log(`  features         ${JSON.stringify(health.features ?? {})}`);
  if ("holder" in health) log(`  holder           ${JSON.stringify(health.holder)}`);
  if (health.features?.holder !== true) problems.push("features.holder is not true: the Worker has no HYVO_TOKEN_ADDRESS yet");
  if (args.openPayments && health.features?.payments !== true) problems.push("features.payments is not true: the Worker has no PAYMENT_ROUTER_ADDRESS yet");
  if (health.holder && holderUnits > 0n && health.holder.min !== args.holderMin) {
    problems.push(`holder.min is ${JSON.stringify(health.holder.min)}, not "${args.holderMin}"`);
  }
  if (health.holder === null && holderUnits > 0n) problems.push("holder is null: holder benefits are off on the Worker");
  for (const problem of problems) log(`  REFUSED  ${problem}`);
  if (problems.length > 0) {
    log("The live API has not switched. Deploy with `pnpm --filter @hyvo/api deploy:cloudflare --yes`, or wait a minute and check again.");
    return 1;
  }
  log("  ok       the live API has switched");
  log(`Now open ${SITE}/token and check the address, ${args.token}, against what the founder sent.`);
  return 0;
}
