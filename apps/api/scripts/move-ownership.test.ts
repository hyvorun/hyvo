/**
 * move-ownership against a local anvil (chain id 4663, anvil's public test keys; nothing touches a real network):
 * deploy PaymentRouter and HyvoOracle from chain/artifacts, run the script, read the chain back.
 * Skipped where Foundry's anvil is not installed. Runs in Node: `pnpm --filter @hyvo/api test:scripts`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORACLE_ABI, ROUTER_ABI } from "./go-live/contracts";
import { deployerKey, moveOwnership, parseOwnershipArgs } from "./go-live/ownership";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const REPO = resolve(API_DIR, "..", "..");

// anvil's default accounts 0, 1 and 2: public test keys, never used on a real network.
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  attester: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  founder: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const satisfies Record<string, Hex>;
const DEPLOYER = privateKeyToAccount(KEYS.deployer).address;
const ATTESTER = privateKeyToAccount(KEYS.attester).address;
const FOUNDER = privateKeyToAccount(KEYS.founder).address;

const ANVIL = spawnSync("anvil", ["--version"], { encoding: "utf8" }).status === 0;

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

describe("deployerKey", () => {
  it("reads DEPLOYER_PRIVATE_KEY from a .env file's text, quoted or not", () => {
    expect(deployerKey(`DEPLOYER_ADDRESS=${DEPLOYER}\nDEPLOYER_PRIVATE_KEY=${KEYS.deployer}\n`)).toBe(KEYS.deployer);
    expect(deployerKey(`export DEPLOYER_PRIVATE_KEY="${KEYS.deployer}"\r\n`)).toBe(KEYS.deployer);
    expect(deployerKey(`DEPLOYER_PRIVATE_KEY='${KEYS.deployer.slice(2)}'`)).toBe(KEYS.deployer);
    expect(deployerKey("DEPLOYER_PRIVATE_KEY=0x1234\n")).toBeNull();
    expect(deployerKey("# DEPLOYER_PRIVATE_KEY=nothing\nOTHER=1\n")).toBeNull();
  });

  it("takes only --founder, --send and --rpc", () => {
    expect(parseOwnershipArgs(["--", "--founder", FOUNDER.toLowerCase()])).toEqual({ ok: true, args: { founder: FOUNDER, send: false, rpcUrls: null } });
    expect(parseOwnershipArgs([`--founder=${FOUNDER}`, "--send", "--rpc", "http://127.0.0.1:8545"])).toEqual({
      ok: true,
      args: { founder: FOUNDER, send: true, rpcUrls: ["http://127.0.0.1:8545"] },
    });
    expect(parseOwnershipArgs(["--founder", "0x00"])).toMatchObject({ ok: false });
    expect(parseOwnershipArgs(["--founder", FOUNDER, "--private-key", KEYS.deployer])).toMatchObject({ ok: false, error: "unknown argument: --private-key" });
  });
});

describe.skipIf(!ANVIL)("move-ownership on a local anvil", () => {
  let anvil: ChildProcess | undefined;
  let rpc = "";
  let dir = "";
  let router: Address;
  let oracle: Address;
  let paths: { deployment: string; productionVars: string; envFile: string };

  const chain = () => defineChain({ id: 4663, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = () => createPublicClient({ chain: chain(), transport: http(rpc), pollingInterval: 100 });

  async function state() {
    const c = client();
    const [treasury, routerOwner, routerPending, oracleOwner, oraclePending] = await Promise.all([
      c.readContract({ address: router, abi: ROUTER_ABI, functionName: "treasury" }),
      c.readContract({ address: router, abi: ROUTER_ABI, functionName: "owner" }),
      c.readContract({ address: router, abi: ROUTER_ABI, functionName: "pendingOwner" }),
      c.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "owner" }),
      c.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "pendingOwner" }),
    ]);
    return { treasury, routerOwner, routerPending, oracleOwner, oraclePending };
  }

  async function move(argv: string[]) {
    const parsed = parseOwnershipArgs(["--founder", FOUNDER, "--rpc", rpc, ...argv]);
    if (!parsed.ok) throw new Error(parsed.error);
    const lines: string[] = [];
    const code = await moveOwnership(parsed.args, {
      read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      log: (line = "") => lines.push(line),
      paths,
      envFileName: "chain/.env",
    });
    return { code, out: lines.join("\n") };
  }

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--port", String(port), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await client().getChainId()) === 4663) break;
      } catch {
        if (Date.now() > deadline) throw new Error("anvil did not start");
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    const wallet = createWalletClient({ account: privateKeyToAccount(KEYS.deployer), chain: chain(), transport: http(rpc) });
    const deploy = async (name: string, args: Address[]) => {
      const { abi, bytecode } = JSON.parse(readFileSync(join(REPO, "chain", "artifacts", `${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
      const hash = await wallet.deployContract({ abi, bytecode, args });
      const receipt = await client().waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error(`${name} did not deploy`);
      return getAddress(receipt.contractAddress);
    };
    // As chain/script/DeployHyvo.s.sol deploys them: the deployer is owner and treasury.
    router = await deploy("PaymentRouter", [DEPLOYER, DEPLOYER]);
    oracle = await deploy("HyvoOracle", [DEPLOYER, ATTESTER]);

    dir = mkdtempSync(join(tmpdir(), "hyvo-move-ownership-"));
    paths = { deployment: join(dir, "4663.json"), productionVars: join(dir, "production.vars.json"), envFile: join(dir, ".env") };
    const deployment = { attester: ATTESTER, block: 1, chainId: 4663, deployer: DEPLOYER, hyvoToken: zeroAddress, oracle, owner: DEPLOYER, paymentRouter: router, treasury: DEPLOYER };
    writeFileSync(paths.deployment, `${JSON.stringify(deployment, null, 2)}\n`);
    // RPC_URLS points at the real chain, as in the repo: every call must take --rpc instead.
    writeFileSync(paths.productionVars, `${JSON.stringify({ RPC_URLS: "https://rpc.invalid" }, null, 2)}\n`);
  });

  afterAll(() => {
    anvil?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("dry run: names the three calls with the chain's state and their gas, and sends nothing", async () => {
    const { code, out } = await move([]);
    expect(code, out).toBe(0);
    expect(out).toContain(`PaymentRouter.setTreasury(${FOUNDER})`);
    expect(out).toContain(`PaymentRouter.transferOwnership(${FOUNDER})`);
    expect(out).toContain(`HyvoOracle.transferOwnership(${FOUNDER})`);
    expect(out).toContain(`now: treasury ${DEPLOYER}`);
    expect(out.match(/to send from the deployer, about [\d,]+ gas/g)).toHaveLength(3);
    expect(out).toMatch(/Gas: about [\d,]+ in all at [\d.]+ gwei, [\d.e-]+ ETH\. The deployer holds [\d.]+ ETH/);
    expect(out).toMatch(/Dry run: nothing was sent/);
    expect(await state()).toEqual({ treasury: DEPLOYER, routerOwner: DEPLOYER, routerPending: zeroAddress, oracleOwner: DEPLOYER, oraclePending: zeroAddress });
  });

  it("refuses to send without the deployer's key, and sends nothing", async () => {
    const missing = await move(["--send"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/REFUSED: chain\/\.env is missing/);

    writeFileSync(paths.envFile, `DEPLOYER_PRIVATE_KEY=${KEYS.attester}\n`);
    const wrong = await move(["--send"]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain(`REFUSED: the key in chain/.env belongs to ${ATTESTER}, not to the deployer ${DEPLOYER}`);
    expect(wrong.out).not.toContain(KEYS.attester.slice(2));
    expect((await state()).treasury).toBe(DEPLOYER);
  });

  it("sends the three calls one at a time, never prints the key, and reads the state back", async () => {
    writeFileSync(paths.envFile, `# chain/.env\nDEPLOYER_ADDRESS=${DEPLOYER}\nDEPLOYER_PRIVATE_KEY="${KEYS.deployer}"\nATTESTER_ADDRESS=${ATTESTER}\n`);
    const { code, out } = await move(["--send"]);
    expect(code, out).toBe(0);
    expect(out).not.toContain(KEYS.deployer.slice(2));
    expect(out.match(/: sent 0x[0-9a-f]{64}/g)).toHaveLength(3);
    expect(out.match(/confirmed in block \d+/g)).toHaveLength(3);
    expect(await state()).toEqual({ treasury: FOUNDER, routerOwner: DEPLOYER, routerPending: FOUNDER, oracleOwner: DEPLOYER, oraclePending: FOUNDER });
    expect(out).toMatch(/ok {5}PaymentRouter\.setTreasury: treasury 0x/);
    expect(out).toContain(`The founder now calls acceptOwnership() from ${FOUNDER}`);
    expect(out).toContain(`https://robinhoodchain.blockscout.com/address/${router}`);
    expect(out).toContain(`https://robinhoodchain.blockscout.com/address/${oracle}`);
  });

  it("can run again: nothing is left to send", async () => {
    const { code, out } = await move(["--send"]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/Nothing to send/);
    expect(out).not.toMatch(/: sent 0x/);
  });

  it("once the founder accepts both, says that he owns them", async () => {
    const founder = createWalletClient({ account: privateKeyToAccount(KEYS.founder), chain: chain(), transport: http(rpc) });
    for (const [address, abi] of [
      [router, ROUTER_ABI],
      [oracle, ORACLE_ABI],
    ] as const) {
      const hash = await founder.writeContract({ address, abi, functionName: "acceptOwnership" });
      expect((await client().waitForTransactionReceipt({ hash })).status).toBe("success");
    }
    expect(await state()).toEqual({ treasury: FOUNDER, routerOwner: FOUNDER, routerPending: zeroAddress, oracleOwner: FOUNDER, oraclePending: zeroAddress });
    const { code, out } = await move([]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/The founder's wallet owns both contracts/);
  });

  it("refuses an RPC whose chain is not the deployment's", async () => {
    writeFileSync(paths.deployment, readFileSync(paths.deployment, "utf8").replace('"chainId": 4663', '"chainId": 1'));
    const { code, out } = await move([]);
    expect(code).toBe(1);
    expect(out).toMatch(/REFUSED: the RPC answers for chain 4663, not 1/);
  });
});
