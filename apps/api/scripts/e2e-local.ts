/**
 * Phase 3 end to end on a local chain (SPEC 14 Phase 3 DoD):
 *
 *   a test user signs in with SIWE and pays test USDG through PaymentRouter
 *   -> the API detects the payment and queues the run
 *   -> the laptop runner (`python -m hyvo runner --once`) plays and delivers it
 *   -> the Worker publishes it and commits its hash to HyvoOracle with the attester key
 *   -> the commit read straight from the chain matches the published run.json
 *   -> the web app's /oracle page, in a real browser, verifies it the same way.
 *
 * Then Phase 5's (SPEC 14): the wallet makes an API key and tops up its balance through PaymentRouter, and the official
 * MCP client, an external program, creates a run, pays from that balance and verifies the hash against the chain.
 *
 * Then Phase 6's: a run carries a question, its date passes, the founder records the outcome, it goes on-chain through
 * HyvoOracle.resolve, and it appears on the calibration page, also in the browser. And a Dry Run: the SDK has a crowd try a
 * contract with planted bugs, a real runner plays it, and the report surfaces them, in a browser signed in with that wallet.
 *
 * Then Phase 7's: the wallet builds its clone from what a stand-in explorer says about it alone, runs it in a crowd, and rewinds a past moment of a real pool on
 * this chain with one thing changed. The run holds what really happened next, read from the chain, and the wallet then deletes its clone.
 *
 * Everything is local and throwaway: anvil (chain id 4663, its public test keys), a fresh
 * `wrangler dev` state directory under apps/api/.wrangler/, the offline rules model. Nothing
 * touches a real network or real money.
 *
 * Run from the repo root: `pnpm --filter @hyvo/api e2e` (needs anvil, the engine's uv env and
 * Playwright's Chromium). `--no-web` skips the browser step; `--keep` leaves anvil, the API and
 * the web app running for a look (prints the URLs).
 */
import { Hyvo } from "@hyvo/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RunV1,
  keccak256Utf8,
  runIdToBytes32,
  scenarioHash,
  verifyRunHash,
  type BalanceResponse,
  type CalibrationResponse,
  type CloneResponse,
  type CreateKeyResponse,
  type Order,
  type RunResponse,
  type TopUp,
  type TopUpCheckResponse,
} from "@hyvo/schema";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const REPO = resolve(API_DIR, "..", "..");
const ENGINE = join(REPO, "engine");
const WEB_DIR = join(REPO, "apps", "web");
const KEEP = process.argv.includes("--keep");
const WEB = !process.argv.includes("--no-web");

// anvil's default accounts (public test keys; never used on a real network).
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  attester: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  treasury: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  user: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;
const RUNNER_TOKEN = "e2e-runner-token";

const children: ChildProcess[] = [];

function log(step: string, detail = ""): void {
  console.log(`[e2e] ${step}${detail ? `: ${detail}` : ""}`);
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

function start(name: string, command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? API_DIR,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) lines.push(line);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  children.push(child);
  return { child, lines, name };
}

/** Stop a child and everything it started (wrangler starts workerd), before this script exits. */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

/** wrangler through node itself: no npx, no shell. */
const WRANGLER = join(API_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

async function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const proc = start(command, command, args, options);
  const code: number = await new Promise((done) => proc.child.on("close", (c) => done(c ?? 1)));
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${code}:\n${proc.lines.slice(-30).join("\n")}`);
  return proc.lines;
}

async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 120_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ""}`);
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(REPO, "chain", "artifacts", `${name}.json`), "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode as Hex };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

/** Answers like Blockscout's REST API (docs/OPEN_ITEMS.md item 24), about one wallet: eight trades in two tokens. */
async function startExplorer(wallet: string) {
  const pool = `0x${"99".repeat(20)}`;
  const tokens = [`0x${"a1".repeat(20)}`, `0x${"b2".repeat(20)}`];
  const start = Date.now() - 30 * 86_400_000;
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const eth = 10n ** 18n;
  const plan = [
    { minute: 10, token: 0, side: "buy", eth: eth / 10n, tokens: 1000n },
    { minute: 40, token: 0, side: "sell", eth: 0n, tokens: 500n },
    { minute: 50, token: 0, side: "sell", eth: 0n, tokens: 500n },
    { minute: 2000, token: 1, side: "buy", eth: eth / 5n, tokens: 100n },
    { minute: 2100, token: 1, side: "buy", eth: eth / 4n, tokens: 100n },
    { minute: 2300, token: 1, side: "sell", eth: 0n, tokens: 50n },
    { minute: 3000, token: 0, side: "buy", eth: eth / 8n, tokens: 400n },
    { minute: 3100, token: 0, side: "sell", eth: 0n, tokens: 400n },
  ].map((trade, index) => ({ ...trade, hash: `0x${(index + 1).toString(16).padStart(64, "0")}` }));
  const answers = new Map<string, unknown>([
    [
      `/addresses/${wallet}/transactions`,
      {
        items: plan.map((trade) => ({ hash: trade.hash, timestamp: at(trade.minute), value: String(trade.eth), from: { hash: wallet }, to: { hash: pool }, method: "swap", status: "ok", result: "success" })),
        next_page_params: null,
      },
    ],
    [
      `/addresses/${wallet}/token-transfers`,
      {
        items: plan.map((trade) => ({
          transaction_hash: trade.hash,
          timestamp: at(trade.minute),
          from: { hash: trade.side === "buy" ? pool : wallet },
          to: { hash: trade.side === "buy" ? wallet : pool },
          token: { address_hash: tokens[trade.token], symbol: trade.token === 0 ? "AAA" : "BBB", decimals: "18", type: "ERC-20" },
          total: { decimals: "18", value: String(trade.tokens * eth) },
        })),
        next_page_params: null,
      },
    ],
    [`/addresses/${tokens[0]}`, { creation_transaction_hash: `0x${"c0".repeat(32)}` }],
    [`/addresses/${tokens[1]}`, { creation_transaction_hash: `0x${"c1".repeat(32)}` }],
    [`/transactions/0x${"c0".repeat(32)}`, { timestamp: at(0) }],
    [`/transactions/0x${"c1".repeat(32)}`, { timestamp: at(0) }],
  ]);
  const asked: string[] = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://explorer.local");
    const path = url.pathname.replace(/^\/api\/v2/, "");
    asked.push(path);
    const answer = url.searchParams.get("apikey") === "e2e-explorer-key" ? answers.get(path) : undefined;
    response.writeHead(answer ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answer ?? { message: "not found" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api/v2`, asked, tokens, close: () => server.close() };
}

/** A pool with a past on this chain: liquidity, then a stretch of blocks, then two swaps that move it, over more than an hour of chain time at a block every ten seconds. */
async function realPool(
  deploy: (name: string, args: unknown[]) => Promise<Address>,
  deployer: ReturnType<typeof createWalletClient> & { account: { address: Address } },
  client: ReturnType<typeof createPublicClient>,
  load: (name: string) => { abi: Abi },
) {
  const owner = deployer.account.address;
  const weth = await deploy("TestWETH", []);
  const token = await deploy("TestToken", ["Fictional Fern", "FERN", owner]);
  const pair = await deploy("HyvoV2Pair", [token, weth, 100]);
  const swapRouter = await deploy("HyvoV2Router", [weth]);
  const tokens = 1_000_000n * 10n ** 18n;
  const send = async (address: Address, abi: Abi, functionName: string, args: unknown[], value = 0n) => {
    const hash = await (deployer as any).writeContract({ address, abi, functionName, args, value, chain: (deployer as any).chain, account: (deployer as any).account });
    await client.waitForTransactionReceipt({ hash });
  };
  await send(token, load("TestToken").abi, "mint", [owner, tokens]);
  await send(token, load("TestToken").abi, "approve", [swapRouter, tokens]);
  await send(swapRouter, load("HyvoV2Router").abi, "addLiquidityETH", [pair, tokens, owner], 5n * 10n ** 18n);
  const block = await client.getBlockNumber();
  const mine = (count: number) => client.request({ method: "anvil_mine" as never, params: [`0x${count.toString(16)}`, "0xa"] as never });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  await mine(100);
  await send(swapRouter, load("HyvoV2Router").abi, "swapExactETHForTokens", [pair, 0n, owner, deadline], 10n ** 18n);
  await mine(100);
  await send(swapRouter, load("HyvoV2Router").abi, "swapExactETHForTokens", [pair, 0n, owner, deadline], 10n ** 18n);
  await mine(300);
  const reserves = (await client.readContract({ address: pair, abi: load("HyvoV2Pair").abi, functionName: "getReserves" })) as readonly [bigint, bigint, number];
  const token0 = (await client.readContract({ address: pair, abi: load("HyvoV2Pair").abi, functionName: "token0" })) as Address;
  const ethReserve = getAddress(token0) === getAddress(weth) ? reserves[0] : reserves[1];
  return { address: pair, block, reserveEthAfter: Number(ethReserve) / 1e18 };
}

async function main(): Promise<void> {
  const anvilPort = await freePort();
  const apiPort = await freePort();
  const webPort = await freePort();
  const rpc = `http://127.0.0.1:${anvilPort}`;
  const api = `http://127.0.0.1:${apiPort}`;
  const web = `http://localhost:${webPort}`;
  const work = join(API_DIR, ".wrangler", `e2e-${Date.now()}`);
  mkdirSync(work, { recursive: true });

  // --- the chain ------------------------------------------------------------------------------
  log("anvil", `chain 4663 on ${rpc}`);
  start("anvil", "anvil", ["--port", String(anvilPort), "--chain-id", "4663", "--silent"]);
  const chain = defineChain({
    id: 4663,
    name: "local Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  await waitFor("anvil", async () => (await publicClient.getChainId()) === 4663 || null, 30_000);

  const deployer = createWalletClient({ account: privateKeyToAccount(KEYS.deployer), chain, transport: http(rpc) });
  const attester = privateKeyToAccount(KEYS.attester).address;
  const treasury = privateKeyToAccount(KEYS.treasury).address;
  const user = privateKeyToAccount(KEYS.user);
  const userWallet = createWalletClient({ account: user, chain, transport: http(rpc) });

  async function deploy(name: string, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = artifact(name);
    const hash = await deployer.deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    check(receipt.contractAddress, `${name} deployed`);
    return getAddress(receipt.contractAddress);
  }

  const usdg = await deploy("TestStablecoin", [deployer.account.address]);
  const oracle = await deploy("HyvoOracle", [deployer.account.address, attester]);
  const router = await deploy("PaymentRouter", [deployer.account.address, treasury]);
  const routerAbi = artifact("PaymentRouter").abi;
  const erc20 = parseAbi([
    "function mint(address to, uint256 amount)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
  ]);
  await publicClient.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: router, abi: routerAbi, functionName: "setTokenAllowed", args: [usdg, true] }),
  });
  await publicClient.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: usdg, abi: erc20, functionName: "mint", args: [user.address, 100_000_000n] }),
  });
  const deployBlock = await publicClient.getBlockNumber();
  log("contracts", `tUSDG ${usdg}, HyvoOracle ${oracle}, PaymentRouter ${router}`);

  // --- the API (wrangler dev with its own config, secrets and state) --------------------------
  const config = JSON.parse(
    readFileSync(join(API_DIR, "wrangler.jsonc"), "utf8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
  delete config.$schema;
  delete config.ai; // the offline rules model plays this run; no remote binding
  delete config.observability;
  config.main = join(API_DIR, "src", "index.ts");
  config.d1_databases[0].migrations_dir = join(API_DIR, "migrations");
  Object.assign(config.vars, {
    RPC_URLS: rpc,
    ORACLE_ADDRESS: oracle,
    PAYMENT_ROUTER_ADDRESS: router,
    PAYMENT_ROUTER_DEPLOY_BLOCK: String(deployBlock),
    PAYMENT_CONFIRMATIONS: "0",
    USDG_ADDRESS: usdg,
    TREASURY_ADDRESS: treasury,
    PUBLIC_API_URL: api,
    // The browser step's web app is the CORS origin and the SIWE domain.
    WEB_ORIGIN: web,
    SIWE_DOMAIN: `localhost:${webPort}`,
    // The test user is the founder here, and a question's date can be seconds away.
    ADMIN_ADDRESSES: user.address,
    QUESTION_MIN_DELAY_S: "1",
    CLONES_ENABLED: "1",
  });
  writeFileSync(join(work, "wrangler.json"), JSON.stringify(config, null, 2));
  writeFileSync(
    join(work, ".dev.vars"),
    `RUNNER_TOKEN=${RUNNER_TOKEN}\nARTIFACT_SIGNING_KEY=e2e-signing-key\nATTESTER_PRIVATE_KEY=${KEYS.attester}\n`,
  );
  const wranglerArgs = ["--config", join(work, "wrangler.json"), "--persist-to", join(work, "state")];
  await run(process.execPath, [WRANGLER, "d1", "migrations", "apply", "hyvo", "--local", ...wranglerArgs], {
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  log("api", `wrangler dev on ${api}`);
  const worker = start(
    "wrangler",
    process.execPath,
    [WRANGLER, "dev", "--port", String(apiPort), "--ip", "127.0.0.1", "--test-scheduled", ...wranglerArgs],
    { env: { WRANGLER_SEND_METRICS: "false" } },
  );
  await waitFor("the API", async () => ((await fetch(`${api}/v1/health`)).ok ? true : null), 120_000).catch((error) => {
    throw new Error(`${error}\n${worker.lines.slice(-30).join("\n")}`);
  });

  const call = async <T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const response = await fetch(`${api}${path}`, { ...init, headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${text}`);
    return JSON.parse(text) as T;
  };

  // --- the test user: sign in, quote, pay -----------------------------------------------------
  const { nonce } = await call<{ nonce: string }>("/v1/auth/siwe/nonce", { method: "POST", body: "{}" });
  const message = createSiweMessage({
    address: user.address,
    chainId: 4663,
    domain: config.vars.SIWE_DOMAIN,
    nonce,
    uri: config.vars.WEB_ORIGIN,
    version: "1",
    statement: "Sign in to Hyvo. This is a signature, not a transaction.",
  });
  const session = await call<{ token: string; address: string }>("/v1/auth/siwe/verify", {
    method: "POST",
    body: JSON.stringify({ message, signature: await user.signMessage({ message }) }),
  });
  log("signed in", session.address);

  const scenario = {
    title: "E2E: fictional token PULSE lists with a 2% fee",
    seedText: "PULSE is a fictional token made up for the local end-to-end test. Liquidity is thin.",
    events: [{ round: 2, text: "A large wallet posts that it entered early." }],
    market: { tokenSymbol: "PULSE", liquidityEth: "5", feeBps: 200 },
  };
  const { order } = await call<{ order: Order }>("/v1/quotes", {
    method: "POST",
    token: session.token,
    body: JSON.stringify({ scenario, agents: 10, rounds: 3 }),
  });
  log("quoted", `${order.amount} base units of tUSDG ($${order.priceUsd}), order ${order.orderId}`);

  const amount = BigInt(order.amount);
  await publicClient.waitForTransactionReceipt({
    hash: await userWallet.writeContract({ address: usdg, abi: erc20, functionName: "approve", args: [router, amount] }),
  });
  const payHash = await userWallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "pay",
    args: [order.orderId, usdg, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: payHash });
  log("paid", payHash);

  const paid = await call<{ order: Order; check: string }>(`/v1/orders/${order.orderId}/payment`, {
    method: "POST",
    token: session.token,
    body: JSON.stringify({ txHash: payHash }),
  });
  check(paid.check === "paid" && paid.order.runId, `payment detected (${paid.check})`);
  const runId = paid.order.runId;
  log("queued", runId);

  // --- the laptop runner ----------------------------------------------------------------------
  log("runner", "python -m hyvo runner --once --offline --no-fork");
  // ENGINE_PYTHON: for a machine where Application Control blocks the venv's python.exe (docs/RUNBOOK.md).
  const [python, ...prefix] = process.env.ENGINE_PYTHON ? [process.env.ENGINE_PYTHON] : ["uv", "run", "python"];
  await run(
    python!,
    [...prefix, "-m", "hyvo", "runner", "--api", api, "--once", "--offline", "--no-fork", "--poll-interval", "1",
     "--work-dir", join(work, "runner")],
    { cwd: ENGINE, env: { RUNNER_TOKEN, PYTHONUTF8: "1", HYVO_NO_DOTENV: "1" } },
  );

  // --- publish and commit ---------------------------------------------------------------------
  const status = await waitFor(
    "the oracle commit to confirm",
    async () => {
      await fetch(`${api}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
      const current = await call<RunResponse>(`/v1/runs/${runId}`);
      return current.oracle?.status === "confirmed" ? current : null;
    },
    60_000,
    1000,
  );
  check(status.run && status.job?.status === "complete", "the run is published and its job complete");
  log("committed", `tx ${status.oracle?.txHash} in block ${status.oracle?.blockNumber}`);

  // --- verify like a third party (docs/API.md "Verifying a run") -------------------------------
  const link = await call<{ url: string }>(`/v1/runs/${runId}/artifact`);
  const bytes = await (await fetch(link.url)).text();
  const document = RunV1.parse(JSON.parse(bytes));
  const hashCheck = verifyRunHash(document);
  check(hashCheck.ok, "run.json hashes to its own hash");
  const onChain = await publicClient.readContract({
    address: oracle,
    abi: parseAbi([
      "function getCommit(bytes32 runId) view returns ((bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint64 committedAt, uint64 resolvedAt, bytes32 outcomeHash))",
    ]),
    functionName: "getCommit",
    args: [runIdToBytes32(runId)],
  });
  check(onChain.reportHash === hashCheck.expected, "on-chain reportHash = keccak256(JCS(run.json without hash))");
  check(onChain.scenarioHash === scenarioHash(document.scenario), "on-chain scenarioHash = keccak256(JCS(run.scenario))");
  check(onChain.committedAt > 0n, "the commit has a timestamp");
  const api_view = await call<{ matches: boolean }>(`/v1/oracle/${runId}`);
  check(api_view.matches === true, "GET /v1/oracle/:runId agrees");

  const balanceOf = (owner: Address) =>
    publicClient.readContract({ address: usdg, abi: erc20, functionName: "balanceOf", args: [owner] });
  check((await balanceOf(treasury)) === amount, "the treasury received the payment");
  check((await balanceOf(router)) === 0n, "the router holds nothing");

  log("verified", `run ${runId}, hash ${hashCheck.expected}`);

  // --- an external MCP client: a run paid from a prepaid balance (SPEC 14 Phase 5) -----------
  const { key } = await call<CreateKeyResponse>("/v1/keys", { method: "POST", token: session.token, body: JSON.stringify({ label: "e2e" }) });
  const { topUp } = await call<{ topUp: TopUp }>("/v1/balance/topups", { method: "POST", token: key, body: JSON.stringify({ amountUsd: 3 }) });
  await publicClient.waitForTransactionReceipt({
    hash: await userWallet.writeContract({ address: usdg, abi: erc20, functionName: "approve", args: [router, BigInt(topUp.amount)] }),
  });
  const topUpTx = await userWallet.writeContract({ address: router, abi: routerAbi, functionName: "pay", args: [topUp.orderId, usdg, BigInt(topUp.amount)] });
  await publicClient.waitForTransactionReceipt({ hash: topUpTx });
  const credited = await call<TopUpCheckResponse>(`/v1/balance/topups/${topUp.orderId}/payment`, { method: "POST", token: key, body: JSON.stringify({ txHash: topUpTx }) });
  check(credited.check === "paid" && credited.topUp.creditedUsd === 3, `the top-up is credited (${credited.check})`);
  log("topped up", `$${credited.topUp.creditedUsd} in ${topUpTx}`);

  const transport = new StreamableHTTPClientTransport(new URL(`${api}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  const client = new Client({ name: "hyvo-e2e", version: "1.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  check(tools.join() === "ask_agent,create_run,get_run,list_recent_runs,verify_run", `the MCP tools are listed (${tools.join()})`);
  const toolCall = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    check(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as Record<string, any>;
  };
  const started = await toolCall("create_run", {
    scenario: { ...scenario, title: "E2E: a crowd started by an MCP client" },
    size: 10,
    rounds: 3,
    requestId: "e2e-mcp-create-1",
  });
  check(started.status === "started" && started.chargedUsd === 1, `create_run paid from the balance (${started.status})`);
  const mcpRunId = started.runId as string;
  log("mcp create_run", `${mcpRunId}, $${started.chargedUsd} from the balance`);
  const left = await call<BalanceResponse>("/v1/balance", { token: key });
  check(left.balanceUsd === 2, `the balance went from 3 to ${left.balanceUsd}`);

  await run(
    python!,
    [...prefix, "-m", "hyvo", "runner", "--api", api, "--once", "--offline", "--no-fork", "--poll-interval", "1",
     "--work-dir", join(work, "runner")],
    { cwd: ENGINE, env: { RUNNER_TOKEN, PYTHONUTF8: "1", HYVO_NO_DOTENV: "1" } },
  );
  const proof = await waitFor(
    "verify_run to see the commit on-chain",
    async () => {
      await fetch(`${api}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
      const answer = await toolCall("verify_run", { runId: mcpRunId });
      return answer.matches === true ? answer : null;
    },
    60_000,
    1000,
  );
  // The client's own proof: the file hashes to the hash, and the chain holds that hash.
  const mcpBytes = await (await fetch(proof.artifact.url)).text();
  const mcpRun = RunV1.parse(JSON.parse(mcpBytes));
  const mcpHash = verifyRunHash(mcpRun);
  check(mcpHash.ok && mcpHash.expected === proof.hash, "the MCP client recomputed the run's hash");
  const mcpChain = await publicClient.readContract({
    address: oracle,
    abi: parseAbi([
      "function getCommit(bytes32 runId) view returns ((bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint64 committedAt, uint64 resolvedAt, bytes32 outcomeHash))",
    ]),
    functionName: "getCommit",
    args: [runIdToBytes32(mcpRunId)],
  });
  check(mcpChain.reportHash === mcpHash.expected, "the chain holds the hash the MCP client recomputed");
  const listed = await toolCall("list_recent_runs", { filter: { titleContains: "MCP client" } });
  check(listed.runs.length === 1 && listed.runs[0].runId === mcpRunId, "list_recent_runs finds it");
  await client.close();
  log("verified over MCP", `run ${mcpRunId}, hash ${mcpHash.expected}`);

  // The SDK reaches the same answer on its own, reading the real contract with no chain library.
  const sdk = new Hyvo({ baseUrl: api, apiKey: key });
  const proven = await sdk.verifyRun(mcpRunId, { rpcUrl: rpc });
  check(proven.ok && proven.source === "chain" && proven.chainMatches === true, `the SDK verified the run (${JSON.stringify(proven)})`);
  check((await sdk.balance()).balanceUsd === 2, "the SDK reads the balance");
  log("verified with the SDK", proven.recomputed);

  // --- a scenario question: lean first, outcome after the date (SPEC 14 Phase 6) ---------------
  const resolvesAt = new Date(Date.now() + 20_000).toISOString().replace(/\.[0-9]{3}Z$/, "Z");
  const questioned = await call<{ runId: string }>("/v1/runs", {
    method: "POST",
    token: key,
    body: JSON.stringify({
      balance: true,
      requestId: "e2e-question-run",
      scenario: { ...scenario, title: "E2E: a crowd with a question", events: [] },
      agents: 10,
      rounds: 3,
      question: { text: "Will PULSE end its first week above its launch price?", resolvesAt },
    }),
  });
  const questionRun = questioned.runId;
  await run(
    python!,
    [...prefix, "-m", "hyvo", "runner", "--api", api, "--once", "--offline", "--no-fork", "--poll-interval", "1",
     "--work-dir", join(work, "runner")],
    { cwd: ENGINE, env: { RUNNER_TOKEN, PYTHONUTF8: "1", HYVO_NO_DOTENV: "1" } },
  );
  const committed = await waitFor(
    "the question's commit",
    async () => {
      await fetch(`${api}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
      const current = await call<RunResponse>(`/v1/runs/${questionRun}`);
      return current.oracle?.status === "confirmed" && current.run ? current : null;
    },
    60_000,
    1000,
  );
  const lean = committed.run!.question!;
  check(lean.yes + lean.no + lean.unsure === 10, "every agent answered");
  const commitAbi = parseAbi([
    "function getCommit(bytes32 runId) view returns ((bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint64 committedAt, uint64 resolvedAt, bytes32 outcomeHash))",
  ]);
  const readCommit = () => publicClient.readContract({ address: oracle, abi: commitAbi, functionName: "getCommit", args: [runIdToBytes32(questionRun)] });
  const before = await readCommit();
  check(before.resolvesAt === BigInt(Math.floor(Date.parse(resolvesAt) / 1000)), "the commit carries the question's date");
  check(before.resolvedAt === 0n, "nothing is resolved before the date");
  log("question committed", `lean ${lean.expectation}: ${lean.yes} yes, ${lean.no} no, ${lean.unsure} unsure`);

  const decide = () =>
    fetch(`${api}/v1/admin/questions/${questionRun}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ outcome: "yes", note: "Recorded by the end-to-end test.", evidenceUrl: "https://example.com/evidence" }),
    });
  check((await decide()).status === 409, "the outcome is refused before the date");
  await waitFor("the question's date", async () => (Date.now() > Date.parse(resolvesAt) + 2000 ? true : null), 40_000, 500);
  // anvil only moves its clock with new blocks: mine one, so that the contract sees the date has passed.
  await publicClient.request({ method: "evm_mine" as never, params: [] as never });
  const decided = await decide();
  check(decided.status === 200, `the outcome is recorded (${decided.status} ${await decided.clone().text()})`);
  const after = await waitFor(
    "the outcome on-chain",
    async () => {
      await fetch(`${api}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
      const current = await readCommit();
      return current.resolvedAt > 0n ? current : null;
    },
    60_000,
    1000,
  );
  const outcomeBytes = await (await fetch(`${api}/v1/runs/${questionRun}/outcome`)).text();
  check(after.outcomeHash === keccak256Utf8(outcomeBytes), "the chain holds the hash of the outcome document");
  const record = await waitFor(
    "the outcome on the calibration record",
    async () => {
      await fetch(`${api}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
      const page = await call<CalibrationResponse>("/v1/calibration");
      const entry = page.resolved.find((item) => item.runId === questionRun);
      return entry?.onChain ? entry : null;
    },
    60_000,
    1000,
  );
  check(record.outcome === "yes" && (record.result === "hit" || record.result === "miss" || record.result === "no_lean"), `the record counts it (${record.result})`);
  log("question resolved", `outcome yes, ${record.result}, tx ${record.txHash}`);

  // --- a Dry Run: a crowd tries a contract with planted bugs (SPEC 14 Phase 6) -----------------
  const sample = JSON.parse(readFileSync(join(ENGINE, "examples", "dryrun", "sample-vault.json"), "utf8"));
  const { dryRun: asked } = await sdk.createDryRun({
    requestId: "e2e-dry-run",
    description: sample.description,
    bytecode: sample.bytecode,
    abi: sample.abi,
    invariants: sample.invariants,
    agents: sample.agents,
    rounds: sample.rounds,
  });
  check(asked.status === "queued" && asked.chargedUsd === 1, `the Dry Run is queued and paid for (${asked.status}, $${asked.chargedUsd})`);
  check((await sdk.balance()).balanceUsd === 0, "the Dry Run's price came out of the balance");
  await run(
    python!,
    [...prefix, "-m", "hyvo", "runner", "--api", api, "--once", "--offline", "--no-fork", "--poll-interval", "1",
     "--work-dir", join(work, "runner")],
    { cwd: ENGINE, env: { RUNNER_TOKEN, PYTHONUTF8: "1", HYVO_NO_DOTENV: "1" } },
  );
  const dryDone = await sdk.waitForDryRun(asked.runId, { timeoutMs: 60_000, intervalMs: 1000 });
  check(dryDone.status === "complete", `the Dry Run finished (${dryDone.status}: ${dryDone.failReason})`);
  const dryReport = await sdk.fetchDryRunReport(asked.runId);
  const found = dryReport.findings.map((finding) => finding.title);
  check(found.includes("isSolvent() became false"), `the report surfaces the broken invariant (${found.join("; ")})`);
  check(found.some((title) => title.startsWith("rescueFunds")), `the report surfaces the open admin function (${found.join("; ")})`);
  check(!found.some((title) => title.includes("setFee")), `the guarded function is not reported (${found.join("; ")})`);
  check(dryReport.findings.every((finding) => finding.severity !== "high" || finding.reproduce.length > 0), "every high finding says how to reproduce it");
  check((await fetch(`${api}/v1/runs/${asked.runId}`)).status === 404, "a Dry Run does not reach the gallery");
  log("dry run", `${found.length} findings in ${dryReport.calls.length} calls, hash ${dryReport.hash}`);

  // --- Wallet Clone: the wallet's own numbers, and one agent that trades by them (SPEC 14 Phase 7) -----
  const { topUp: secondTopUp } = await call<{ topUp: TopUp }>("/v1/balance/topups", { method: "POST", token: key, body: JSON.stringify({ amountUsd: 2 }) });
  await publicClient.waitForTransactionReceipt({
    hash: await userWallet.writeContract({ address: usdg, abi: erc20, functionName: "approve", args: [router, BigInt(secondTopUp.amount)] }),
  });
  const secondTopUpTx = await userWallet.writeContract({ address: router, abi: routerAbi, functionName: "pay", args: [secondTopUp.orderId, usdg, BigInt(secondTopUp.amount)] });
  await publicClient.waitForTransactionReceipt({ hash: secondTopUpTx });
  await call<TopUpCheckResponse>(`/v1/balance/topups/${secondTopUp.orderId}/payment`, { method: "POST", token: key, body: JSON.stringify({ txHash: secondTopUpTx }) });

  const explorer = await startExplorer(user.address);
  const started0 = await call<CloneResponse>("/v1/clones/me", { method: "POST", token: session.token });
  check(started0.clone?.status === "building", `the clone is being built (${started0.clone?.status})`);
  await run(
    python!,
    [...prefix, "-m", "hyvo", "runner", "--api", api, "--once", "--offline", "--no-fork", "--poll-interval", "1",
     "--work-dir", join(work, "runner")],
    { cwd: ENGINE, env: { RUNNER_TOKEN, PYTHONUTF8: "1", HYVO_NO_DOTENV: "1", BLOCKSCOUT_API_KEY: "e2e-explorer-key", BLOCKSCOUT_API_URL: explorer.url } },
  );
  const built = await call<CloneResponse>("/v1/clones/me", { token: session.token });
  check(built.clone?.status === "ready" && built.clone.profile?.trades === 8, `the clone is built from the wallet's trades (${JSON.stringify(built.clone)})`);
  check(explorer.asked.every((path) => !path.includes("/addresses/") || path.includes(user.address) || explorer.tokens.some((token) => path.includes(token))), `only this wallet was read (${explorer.asked.join(", ")})`);
  check(!JSON.stringify(built.clone?.profile).includes("0x"), "the profile holds no address");
  log("clone built", `${built.clone!.profile!.trades} trades, typical buy ${built.clone!.profile!.typicalBuyEth} ETH`);

  const cloneOrder = await call<{ runId: string }>("/v1/runs", {
    method: "POST",
    token: key,
    body: JSON.stringify({ balance: true, clone: true, requestId: "e2e-clone-run", scenario: { ...scenario, title: "E2E: a clone in a crowd", events: [] }, agents: 10, rounds: 3 }),
  });
  const cloneRunId = cloneOrder.runId;
  await run(
    python!,
    [...prefix, "-m", "hyvo", "runner", "--api", api, "--once", "--offline", "--no-fork", "--poll-interval", "1",
     "--work-dir", join(work, "runner")],
    { cwd: ENGINE, env: { RUNNER_TOKEN, PYTHONUTF8: "1", HYVO_NO_DOTENV: "1" } },
  );
  const clonePublished = await sdk.waitForRun(cloneRunId, { timeoutMs: 60_000, intervalMs: 1000 });
  check(clonePublished.run, `the run with a clone is published (${clonePublished.job?.status})`);
  const cloneBytes = await sdk.fetchRunBytes(cloneRunId);
  const cloneDoc = RunV1.parse(JSON.parse(cloneBytes));
  check(verifyRunHash(cloneDoc).ok, "the run with a clone matches its hash");
  check(cloneDoc.crowd.personaMix.clone === 1 && cloneDoc.crowd.agents.filter((agent) => agent.persona === "clone").length === 1, "one agent of the crowd is the clone");
  check(!cloneBytes.toLowerCase().includes(user.address.toLowerCase()) && !cloneBytes.includes("typicalBuyEth"), "the run holds neither the wallet nor its numbers");
  const gallery = await call<{ runs: { runId: string }[] }>("/v1/runs?limit=50");
  check(!gallery.runs.some((item) => item.runId === cloneRunId), "a run with a clone stays out of the gallery");
  log("clone in a crowd", `run ${cloneRunId}`);

  // --- Rewind: a past moment of a real pool on this chain, with one thing changed (SPEC 14 Phase 7) ----
  const pool = await realPool(deploy, deployer, publicClient, artifact);
  const rewindOrder = await call<{ runId: string }>("/v1/runs", {
    method: "POST",
    token: key,
    body: JSON.stringify({
      balance: true,
      requestId: "e2e-rewind-run",
      rewind: { pool: pool.address, block: Number(pool.block), hours: 1 },
      scenario: { title: "E2E: a rewind with one thing changed", seedText: "", events: [{ round: 2, text: "A large wallet posts that it will keep its tokens for a month." }] },
      agents: 10,
      rounds: 3,
    }),
  });
  const rewindRunId = rewindOrder.runId;
  await run(
    python!,
    [...prefix, "-m", "hyvo", "runner", "--api", api, "--once", "--offline", "--fork", "--poll-interval", "1",
     "--work-dir", join(work, "runner")],
    { cwd: ENGINE, env: { RUNNER_TOKEN, PYTHONUTF8: "1", HYVO_NO_DOTENV: "1", RH_RPC_URL: rpc } },
  );
  const rewindPublished = await sdk.waitForRun(rewindRunId, { timeoutMs: 60_000, intervalMs: 1000 });
  check(rewindPublished.run, `the rewind is published (${rewindPublished.job?.status})`);
  const rewindDoc = RunV1.parse(JSON.parse(await sdk.fetchRunBytes(rewindRunId)));
  check(verifyRunHash(rewindDoc).ok, "the rewind matches its hash");
  const rewound = rewindDoc.rewind!;
  check(rewindDoc.world.forkBlock === Number(pool.block) && rewound.block === Number(pool.block), `it was forked at the block (${rewindDoc.world.forkBlock})`);
  check(rewound.actual[0]!.reserveEth === "5", `it starts from what the pool held at the block (${rewound.actual[0]!.reserveEth})`);
  check(rewound.actual.at(-1)!.price !== rewound.actual[0]!.price, "what really happened next is in the file: the pool moved");
  check(Number(rewound.actual.at(-1)!.reserveEth) === Number(pool.reserveEthAfter), `and it is what the chain says (${rewound.actual.at(-1)!.reserveEth}, ${pool.reserveEthAfter})`);
  check(rewindDoc.scenario.injectedEvents.length === 1 && rewound.change === rewindDoc.scenario.injectedEvents[0]!.text, "one thing is changed, and the run says which");
  check(rewindDoc.world.pools[0]!.kind === "v2-test", "it played on a test pair, and says so");
  const galleryNow = await call<{ runs: { runId: string }[] }>("/v1/runs?limit=50");
  check(!galleryNow.runs.some((item) => item.runId === rewindRunId), "a rewind stays out of the gallery");
  log("rewound", `block ${rewound.block}: the real pool went from ${rewound.actual[0]!.price} to ${rewound.actual.at(-1)!.price}, this run to ${rewindDoc.rounds.at(-1)!.market.price}`);

  // --- the same check in a browser, on the web app's /oracle page --------------------------
  let screenshot: string | null = null;
  if (WEB) {
    log("web", `vite on ${web}`);
    const vite = start("vite", process.execPath, [join(WEB_DIR, "node_modules", "vite", "bin", "vite.js"), "--port", String(webPort), "--strictPort"], {
      cwd: WEB_DIR,
      env: { VITE_API_URL: api, VITE_RPC_URLS: rpc, VITE_ORACLE_ADDRESS: oracle },
    });
    await waitFor("the web app", async () => ((await fetch(web)).ok ? true : null), 60_000).catch((error) => {
      throw new Error(`${error}\n${vite.lines.slice(-20).join("\n")}`);
    });
    const require = createRequire(join(WEB_DIR, "package.json"));
    // Playwright lives in apps/web; its CommonJS entry arrives as `default` when imported from here.
    const loaded = (await import(pathToFileURL(require.resolve("@playwright/test")).href)) as {
      chromium?: typeof import("@playwright/test").chromium;
      default?: { chromium: typeof import("@playwright/test").chromium };
    };
    const chromium = loaded.chromium ?? loaded.default!.chromium;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${web}/oracle?run=${runId}`);
      await page.getByRole("heading", { name: /^Verified: the published run matches its on-chain commit/ }).waitFor({ timeout: 60_000 });
      const passed = await page.getByText("passed", { exact: true }).count();
      check(passed === 3, `the browser passed all three checks (${passed})`);
      screenshot = join(work, "oracle-verified.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      await page.goto(`${web}/calibration`);
      await page.getByText("Will PULSE end its first week above its launch price?").waitFor({ timeout: 30_000 });

      // A report is private, so this page signs in with the wallet that asked for it.
      const owner = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await owner.exposeFunction("__e2eWallet", async (method: string, params: unknown[]) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [user.address];
        if (method === "personal_sign") return user.signMessage({ message: { raw: params[0] as Hex } });
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
        return publicClient.request({ method, params } as never);
      });
      // A string: a function from here would carry helpers that tsx adds, which the page does not have.
      await owner.addInitScript(`window.ethereum = { request: ({ method, params }) => window.__e2eWallet(method, params ?? []), on() {}, removeListener() {} };`);
      await owner.goto(`${web}/dryrun/${asked.runId}`);
      await owner.getByRole("button", { name: "Sign in" }).click();
      await owner.getByRole("heading", { name: "isSolvent() became false" }).waitFor({ timeout: 60_000 });
      await owner.getByText("This file matches its hash, checked in your browser.").waitFor({ timeout: 30_000 });
      await owner.screenshot({ path: join(work, "dryrun-report.png"), fullPage: true });

      // The clone's page, the run it played in and the rewind, then the delete, by the wallet itself.
      await owner.goto(`${web}/clone`);
      await owner.getByRole("heading", { name: "What the clone trades by" }).waitFor({ timeout: 30_000 });
      await owner.screenshot({ path: join(work, "clone.png"), fullPage: true });
      await owner.goto(`${web}/run/${cloneRunId}`);
      await owner.getByRole("heading", { name: "The clone in this crowd" }).waitFor({ timeout: 30_000 });
      await owner.goto(`${web}/run/${rewindRunId}`);
      await owner.getByRole("heading", { name: "Next to what actually happened" }).waitFor({ timeout: 30_000 });
      await owner.screenshot({ path: join(work, "rewind.png"), fullPage: true });
      await owner.goto(`${web}/clone`);
      await owner.getByRole("button", { name: "Delete my clone" }).click();
      await owner.getByRole("button", { name: "Delete for good" }).click();
      await owner.getByRole("button", { name: "Build my clone" }).waitFor({ timeout: 30_000 });
    } finally {
      await browser.close();
    }
    log("verified on /oracle", screenshot);
  } else {
    await fetch(`${api}/v1/clones/me`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
  }
  const afterDelete = await call<CloneResponse>("/v1/clones/me", { token: session.token });
  check(afterDelete.clone === null, "the clone is gone when the wallet deletes it");
  explorer.close();
  console.log(
    JSON.stringify(
      { ok: true, runId, hash: hashCheck.expected, oracle, router, usdg, commitTx: status.oracle?.txHash, payTx: payHash, api, rpc, web: WEB ? web : null, screenshot },
      null,
      2,
    ),
  );
  if (KEEP) {
    log("kept running", `API ${api}, RPC ${rpc}${WEB ? `, web ${web}` : ""}. Ctrl+C stops.`);
    await new Promise(() => undefined);
  }
}

main()
  .then(() => {
    for (const child of children) killTree(child);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    for (const child of children) killTree(child);
    process.exit(1);
  });

process.on("SIGINT", () => {
  for (const child of children) killTree(child);
  process.exit(130);
});
