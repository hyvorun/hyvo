/**
 * token:go-live against a stubbed chain, on temporary copies of the three files it writes.
 * Runs in Node: `pnpm --filter @hyvo/api test:scripts` (scripts/vitest.config.ts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionResult, getAddress, zeroAddress, type Abi, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERC20_ABI, FACTORY_ABI, ORACLE_ABI, PONS_V2_FACTORY, ROUTER_ABI, type LaunchedToken } from "./go-live/contracts";
import { liveReadmeBlock, patchJson, README_END, README_START, replaceMarked } from "./go-live/files";
import { effectiveVars, GUARDED_VARS, paymentsWithoutAdmin } from "./go-live/guard";
import { Rpc, type FetchLike } from "./go-live/rpc";
import { goLive, normalizeAmount, parseArgs, type Paths } from "./go-live/token";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const REPO = resolve(API_DIR, "..", "..");

const REAL_DEPLOYMENT = JSON.parse(readFileSync(join(REPO, "chain", "deployments", "4663.json"), "utf8")) as Record<string, unknown>;
const ROUTER = getAddress(String(REAL_DEPLOYMENT.paymentRouter));
const ORACLE = getAddress(String(REAL_DEPLOYMENT.oracle));
const DEPLOYER = getAddress(String(REAL_DEPLOYMENT.deployer));

const TOKEN = getAddress("0x00000000000000000000000000000000000a11ce");
const FOUNDER = getAddress("0x000000000000000000000000000000000000f00d");
const STRANGER = getAddress("0x000000000000000000000000000000000000beef");
const CURVE = getAddress("0x000000000000000000000000000000000000c0de");
const BLOCK = 110_000_000n;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

/** The keys token:go-live writes; the fixtures start without them, as the repo did before the launch. */
const GO_LIVE_VARS = [
  "HYVO_TOKEN_ADDRESS",
  "HYVO_TOKEN_DECIMALS",
  "HOLDER_MIN",
  "PAYMENT_ROUTER_ADDRESS",
  "PAYMENT_ROUTER_DEPLOY_BLOCK",
  "TREASURY_ADDRESS",
  "ADMIN_ADDRESSES",
];

const README_TEXT = [
  "# Hyvo",
  "",
  "A parallel world for Robinhood Chain.",
  "",
  README_START,
  "## The HYVO token",
  "",
  "Hyvo has not launched a token yet.",
  README_END,
  "",
  "## License",
  "",
  "AGPL-3.0.",
  "",
].join("\n");

const ABI = [...ERC20_ABI, ...FACTORY_ABI, ...ROUTER_ABI, ...ORACLE_ABI] as Abi;
const key = (address: string, functionName: string) => `${address.toLowerCase()}:${functionName}`;

interface World {
  chainId: number;
  code: Record<string, Hex>;
  /** `${address}:${function}` -> the value it returns; a missing entry reverts. */
  calls: Record<string, unknown>;
}

function record(overrides: Partial<LaunchedToken> = {}): LaunchedToken {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: FOUNDER,
    creatorFeeRecipient: FOUNDER,
    pairToken: zeroAddress,
    graduationThreshold: 4_200_000_000_000_000_000n,
    poolFee: 10_000,
    tickSpacing: 200,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: 0,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: true,
    ...overrides,
  };
}

/** The founder launched Hyvo/HYVO on Pons V2, PaymentRouter pays him, and he owns both contracts. */
function world(changes: { calls?: Record<string, unknown>; code?: Record<string, Hex>; chainId?: number } = {}): World {
  return {
    chainId: changes.chainId ?? 4663,
    code: { [TOKEN.toLowerCase()]: "0x6080604052", ...changes.code },
    calls: {
      [key(TOKEN, "name")]: "Hyvo",
      [key(TOKEN, "symbol")]: "HYVO",
      [key(TOKEN, "decimals")]: 18,
      [key(TOKEN, "totalSupply")]: SUPPLY,
      [key(PONS_V2_FACTORY, "getLaunchedToken")]: record(),
      [key(ROUTER, "treasury")]: FOUNDER,
      [key(ROUTER, "owner")]: FOUNDER,
      [key(ROUTER, "pendingOwner")]: zeroAddress,
      [key(ROUTER, "allowedToken")]: true,
      [key(ORACLE, "owner")]: FOUNDER,
      [key(ORACLE, "pendingOwner")]: zeroAddress,
      ...changes.calls,
    },
  };
}

/** A JSON-RPC endpoint that answers from `world`, and remembers the methods it was asked. */
function stub(state: World, methods: string[] = []): FetchLike {
  return async (_url, init) => {
    const { method, params } = JSON.parse(init.body ?? "{}") as { method: string; params: unknown[] };
    methods.push(method);
    const reply = (body: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, ...body }) });
    switch (method) {
      case "eth_chainId":
        return reply({ result: `0x${state.chainId.toString(16)}` });
      case "eth_blockNumber":
        return reply({ result: `0x${BLOCK.toString(16)}` });
      case "eth_getCode":
        return reply({ result: state.code[String(params[0]).toLowerCase()] ?? "0x" });
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: Hex };
        expect(params[1]).toBe(`0x${BLOCK.toString(16)}`); // every read is pinned to one block
        const { functionName } = decodeFunctionData({ abi: ABI, data });
        const entry = key(to, functionName);
        if (!(entry in state.calls)) return reply({ error: { code: 3, message: "execution reverted" } });
        return reply({ result: encodeFunctionResult({ abi: ABI, functionName, result: state.calls[entry] } as never) });
      }
      default:
        return reply({ error: { code: -32601, message: `no ${method} here` } });
    }
  };
}

let dir: string;
let paths: Paths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hyvo-go-live-"));
  paths = { deployment: join(dir, "4663.json"), productionVars: join(dir, "production.vars.json"), readme: join(dir, "README.md") };
  // Copies of the repo's own files, as they were before the launch.
  writeFileSync(paths.deployment, patchJson(readFileSync(join(REPO, "chain", "deployments", "4663.json"), "utf8"), { hyvoToken: zeroAddress, owner: DEPLOYER, treasury: DEPLOYER }));
  const vars = JSON.parse(readFileSync(join(API_DIR, "production.vars.json"), "utf8")) as Record<string, string>;
  for (const name of GO_LIVE_VARS) delete vars[name];
  writeFileSync(paths.productionVars, `${JSON.stringify(vars, null, 2)}\n`);
  writeFileSync(paths.readme, README_TEXT);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv: string[], state: World = world(), fetch?: FetchLike) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  const lines: string[] = [];
  const written: string[] = [];
  const methods: string[] = [];
  const code = await goLive(parsed.args, {
    io: {
      read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      write: (path, text) => {
        written.push(path);
        writeFileSync(path, text);
      },
    },
    paths,
    log: (line = "") => lines.push(line),
    rpc: new Rpc(["https://rpc.test"], stub(state, methods)),
    fetch,
  });
  return { code, out: lines.join("\n"), written, methods };
}

const BASE = ["--token", TOKEN, "--founder", FOUNDER, "--holder-min", "100000"];
const files = () => ({
  deployment: JSON.parse(readFileSync(paths.deployment, "utf8")) as Record<string, unknown>,
  vars: JSON.parse(readFileSync(paths.productionVars, "utf8")) as Record<string, string>,
  readme: readFileSync(paths.readme, "utf8"),
});

describe("token:go-live", () => {
  it("writes the token and opens payments when the founder launched it and the treasury is his", async () => {
    const before = files();
    const { code, out, written } = await run([...BASE, "--open-payments", "--write"]);
    expect(code, out).toBe(0);
    expect(written.sort()).toEqual([paths.deployment, paths.productionVars, paths.readme].sort());
    const after = files();

    expect(after.deployment).toEqual({ ...before.deployment, hyvoToken: TOKEN, owner: FOUNDER, treasury: FOUNDER });
    expect(Object.keys(after.deployment)).toEqual(Object.keys(before.deployment)); // the key order is kept

    expect(after.vars).toEqual({
      ...before.vars,
      HYVO_TOKEN_ADDRESS: TOKEN,
      HYVO_TOKEN_DECIMALS: "18",
      HOLDER_MIN: "100000",
      PAYMENT_ROUTER_ADDRESS: ROUTER,
      PAYMENT_ROUTER_DEPLOY_BLOCK: String(BLOCK),
      TREASURY_ADDRESS: FOUNDER,
      ADMIN_ADDRESSES: FOUNDER,
    });
    expect(Object.keys(after.vars)).toEqual([...Object.keys(before.vars), ...GO_LIVE_VARS]);
    expect(readFileSync(paths.productionVars, "utf8").endsWith("}\n")).toBe(true);
    // What the deploy script refuses (payments with no admin) cannot come out of the go-live.
    expect(paymentsWithoutAdmin(after.vars)).toBeNull();

    expect(out).toMatch(/Written: chain\/deployments\/4663\.json, apps\/api\/production\.vars\.json, README\.md\./);
    expect(out).toMatch(/deploy:cloudflare --yes/);
    expect(out).toMatch(/--verify/);
  });

  it("replaces only what lies between the README markers, with the official address", async () => {
    await run([...BASE, "--write"]);
    const readme = files().readme;
    const [head, rest] = README_TEXT.split(README_START);
    const tail = rest!.split(README_END)[1];
    expect(readme.startsWith(`${head}${README_START}\n`)).toBe(true);
    expect(readme.endsWith(`${README_END}${tail}`)).toBe(true);
    const block = readme.slice(readme.indexOf(README_START) + README_START.length, readme.indexOf(README_END));
    expect(block).toContain("## The HYVO token"); // the block's heading stays
    expect(block).not.toContain("has not launched");
    expect(block).toContain(`[\`${TOKEN}\`](https://robinhoodchain.blockscout.com/address/${TOKEN})`);
    expect(block).toContain("(https://hyvo.run/token)");
    expect(block).not.toMatch(/\b(buy|sell|guaranteed|pump|price|safe|scam|rug|honeypot|legit|risky)\b/i);
  });

  it("is a dry run without --write: it prints the changes and writes nothing", async () => {
    const before = { deployment: readFileSync(paths.deployment, "utf8"), vars: readFileSync(paths.productionVars, "utf8"), readme: readFileSync(paths.readme, "utf8") };
    const { code, out, written } = await run([...BASE, "--open-payments"]);
    expect(code, out).toBe(0);
    expect(written).toEqual([]);
    expect(readFileSync(paths.deployment, "utf8")).toBe(before.deployment);
    expect(readFileSync(paths.productionVars, "utf8")).toBe(before.vars);
    expect(readFileSync(paths.readme, "utf8")).toBe(before.readme);
    expect(out).toMatch(/dry run/);
    expect(out).toMatch(/HYVO_TOKEN_ADDRESS\s+\(not set\) -> 0x/);
    expect(out).toMatch(/Dry run: nothing was written/);
  });

  it("refuses a token the Pons factory says someone else created, and writes nothing", async () => {
    const state = world({ calls: { [key(PONS_V2_FACTORY, "getLaunchedToken")]: record({ deployer: STRANGER, creatorFeeRecipient: STRANGER }) } });
    const { code, out, written } = await run([...BASE, "--write"], state);
    expect(code).toBe(1);
    expect(written).toEqual([]);
    expect(out).toMatch(/REFUSED\s+the Pons V2 factory names 0x0{36}[Bb][Ee][Ee][Ff] as the creator, not the founder's wallet/);
    expect(out).toMatch(/REFUSED: nothing was written/);
    expect(files().deployment.hyvoToken).toBe(zeroAddress);
  });

  it("goes on with --force, loudly", async () => {
    const state = world({ calls: { [key(PONS_V2_FACTORY, "getLaunchedToken")]: record({ deployer: STRANGER }) } });
    const { code, out } = await run([...BASE, "--write", "--force"], state);
    expect(code, out).toBe(0);
    expect(out).toMatch(/FORCED\s+the Pons V2 factory names/);
    expect(out).toMatch(/!!! --force is overriding a refusal above/);
    expect(files().deployment.hyvoToken).toBe(TOKEN);
  });

  it("refuses an address the factory has no launch of", async () => {
    const state = world({ calls: { [key(PONS_V2_FACTORY, "getLaunchedToken")]: record({ exists: false, token: zeroAddress }) } });
    const { code, out } = await run(BASE, state);
    expect(code).toBe(1);
    expect(out).toMatch(/REFUSED\s+the Pons V2 factory has no launch of/);
  });

  it("warns when the name or symbol is not Hyvo and HYVO, and still goes on", async () => {
    const state = world({ calls: { [key(TOKEN, "name")]: "Hyvo Run", [key(TOKEN, "symbol")]: "HYV" } });
    const { code, out } = await run([...BASE, "--write"], state);
    expect(code, out).toBe(0);
    expect(out).toMatch(/WARNING\s+name and symbol are "Hyvo Run" and "HYV", not "Hyvo" and "HYVO"/);
    expect(files().vars.HYVO_TOKEN_ADDRESS).toBe(TOKEN);
  });

  it("refuses an address with no contract, even with --force", async () => {
    const state = world({ code: { [TOKEN.toLowerCase()]: "0x" } });
    const { code, out, written } = await run([...BASE, "--write", "--force"], state);
    expect(code).toBe(1);
    expect(written).toEqual([]);
    expect(out).toMatch(/REFUSED\s+no contract at 0x0{35}[Aa]11[Cc][Ee] at block 110000000: this address is not a token/);
  });

  it("refuses to open payments while the treasury is not the founder's, and names the command to run first", async () => {
    const state = world({ calls: { [key(ROUTER, "treasury")]: DEPLOYER, [key(ROUTER, "owner")]: DEPLOYER, [key(ORACLE, "owner")]: DEPLOYER } });
    const { code, out, written } = await run([...BASE, "--open-payments", "--write"], state);
    expect(code).toBe(1);
    expect(written).toEqual([]);
    expect(out).toMatch(/REFUSED\s+PaymentRouter's treasury is 0x[0-9a-fA-F]{40}, not the founder's wallet: payments stay closed/);
    expect(out).toContain(`pnpm --filter @hyvo/api move-ownership -- --founder ${FOUNDER}`);
    expect(files().vars.PAYMENT_ROUTER_ADDRESS).toBeUndefined();
  });

  it("opens payments with the treasury moved but ownership not yet accepted, and says what is left", async () => {
    const state = world({
      calls: {
        [key(ROUTER, "owner")]: DEPLOYER,
        [key(ROUTER, "pendingOwner")]: FOUNDER,
        [key(ORACLE, "owner")]: DEPLOYER,
        [key(ORACLE, "pendingOwner")]: FOUNDER,
      },
    });
    const { code, out } = await run([...BASE, "--open-payments", "--write"], state);
    expect(code, out).toBe(0);
    expect(out).toMatch(/WARNING\s+PaymentRouter: the founder's wallet still has to call acceptOwnership\(\)/);
    expect(out).toMatch(/WARNING\s+HyvoOracle: the founder's wallet still has to call acceptOwnership\(\)/);
    const { deployment, vars } = files();
    expect(deployment.owner).toBe(DEPLOYER); // what the chain says, not what is coming
    expect(deployment.treasury).toBe(FOUNDER);
    expect(vars.TREASURY_ADDRESS).toBe(FOUNDER);
  });

  it("refuses to open payments when PaymentRouter does not accept USDG", async () => {
    const { code, out } = await run([...BASE, "--open-payments"], world({ calls: { [key(ROUTER, "allowedToken")]: false } }));
    expect(code).toBe(1);
    expect(out).toMatch(/REFUSED\s+PaymentRouter does not accept USDG/);
  });

  it("leaves payments closed without --open-payments, and never reads PaymentRouter", async () => {
    const { code, out, methods } = await run([...BASE, "--write"]);
    expect(code, out).toBe(0);
    const { vars } = files();
    expect(vars.HYVO_TOKEN_ADDRESS).toBe(TOKEN);
    for (const name of ["PAYMENT_ROUTER_ADDRESS", "PAYMENT_ROUTER_DEPLOY_BLOCK", "TREASURY_ADDRESS", "ADMIN_ADDRESSES"]) expect(vars[name]).toBeUndefined();
    expect(out).toMatch(/note\s+paid runs stay closed/);
    expect(methods.filter((method) => method === "eth_call")).toHaveLength(5); // name, symbol, decimals, supply, the factory
  });

  it("keeps other admins, and the payment scan's start block once payments are open", async () => {
    const other = getAddress("0x0000000000000000000000000000000000000abc");
    writeFileSync(paths.productionVars, patchJson(readFileSync(paths.productionVars, "utf8"), { ADMIN_ADDRESSES: other, PAYMENT_ROUTER_ADDRESS: ROUTER, PAYMENT_ROUTER_DEPLOY_BLOCK: "109000000" }));
    const { code, out } = await run([...BASE, "--open-payments", "--write"]);
    expect(code, out).toBe(0);
    expect(files().vars.ADMIN_ADDRESSES).toBe(`${FOUNDER},${other}`);
    expect(files().vars.PAYMENT_ROUTER_DEPLOY_BLOCK).toBe("109000000");
  });

  it("can run again: a second --write finds nothing to change", async () => {
    await run([...BASE, "--open-payments", "--write"]);
    const { code, out, written } = await run([...BASE, "--open-payments", "--write"]);
    expect(code, out).toBe(0);
    expect(written).toEqual([]);
    expect(out).toMatch(/Changes: none/);
  });

  it("refuses a holder minimum above the total supply, or finer than the token's decimals", async () => {
    const above = await run(["--token", TOKEN, "--founder", FOUNDER, "--holder-min", "1000000001"]);
    expect(above.code).toBe(1);
    expect(above.out).toMatch(/is more than the total supply/);
    const fine = await run(["--token", TOKEN, "--founder", FOUNDER, "--holder-min", "1.5"], world({ calls: { [key(TOKEN, "decimals")]: 0, [key(TOKEN, "totalSupply")]: 1_000_000n } }));
    expect(fine.code).toBe(1);
    expect(fine.out).toMatch(/has more decimals than the token's 0/);
  });

  it("warns that a holder minimum of 0 keeps holder benefits off", async () => {
    const { code, out } = await run(["--token", TOKEN, "--founder", FOUNDER, "--holder-min", "0"]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/WARNING\s+HOLDER_MIN is 0: holder benefits stay off/);
  });

  it("refuses an RPC that is not Robinhood Chain", async () => {
    const { code, out, methods } = await run(BASE, world({ chainId: 1 }));
    expect(code).toBe(1);
    expect(out).toMatch(/not Robinhood Chain \(4663\)/);
    expect(methods).toEqual(["eth_chainId"]);
  });

  it("leaves a README without markers alone, with a warning", async () => {
    writeFileSync(paths.readme, "# Hyvo\n\nNo markers here.\n");
    const { code, out, written } = await run([...BASE, "--write"]);
    expect(code, out).toBe(0);
    expect(written).not.toContain(paths.readme);
    expect(out).toMatch(/WARNING\s+README\.md: no <!-- hyvo-token:start --> and <!-- hyvo-token:end --> lines, so it is left as is/);
    expect(readFileSync(paths.readme, "utf8")).toBe("# Hyvo\n\nNo markers here.\n");
  });

  it("--verify checks the live API's health against the files", async () => {
    await run([...BASE, "--open-payments", "--write"]);
    const health = (body: unknown): FetchLike => async (url) =>
      url === "https://api.hyvo.run/v1/health" ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
    const live = { ok: true, features: { payments: true, oracle: true, holder: true, clone: false }, holder: { min: "100000", decimals: 18, heldForSeconds: 86_400 } };
    const good = await run([...BASE, "--open-payments", "--verify"], world(), health(live));
    expect(good.code, good.out).toBe(0);
    expect(good.out).toMatch(/ok\s+the live API has switched/);

    const stale = await run([...BASE, "--open-payments", "--verify"], world(), health({ ok: true, features: { payments: false, oracle: true, holder: false, clone: false } }));
    expect(stale.code).toBe(1);
    expect(stale.out).toMatch(/features\.holder is not true/);
    expect(stale.out).toMatch(/features\.payments is not true/);

    const wrongMin = await run([...BASE, "--verify"], world(), health({ ...live, holder: { ...live.holder, min: "5" } }));
    expect(wrongMin.code).toBe(1);
    expect(wrongMin.out).toMatch(/holder\.min is "5", not "100000"/);
  });
});

describe("arguments", () => {
  it("parses the founder's message, with or without pnpm's separator", () => {
    const parsed = parseArgs(["--", "--token", TOKEN.toLowerCase(), "--founder", FOUNDER.toLowerCase(), "--holder-min", "0100000.50", "--open-payments", "--write"]);
    expect(parsed).toEqual({
      ok: true,
      args: { token: TOKEN, founder: FOUNDER, holderMin: "100000.5", openPayments: true, write: true, force: false, verify: false, rpcUrls: null },
    });
    const inline = parseArgs([`--token=${TOKEN}`, `--founder=${FOUNDER}`, "--holder-min=1_000", "--rpc", "https://a.test, https://b.test"]);
    expect(inline.ok && inline.args.holderMin).toBe("1000");
    expect(inline.ok && inline.args.rpcUrls).toEqual(["https://a.test", "https://b.test"]);
  });

  it("refuses what is not an address or an amount", () => {
    expect(parseArgs(["--token", "0x123", "--founder", FOUNDER, "--holder-min", "1"])).toMatchObject({ ok: false, error: expect.stringMatching(/--token/) });
    expect(parseArgs(["--token", TOKEN, "--founder", zeroAddress, "--holder-min", "1"])).toMatchObject({ ok: false, error: expect.stringMatching(/--founder/) });
    expect(parseArgs(["--token", TOKEN, "--founder", TOKEN, "--holder-min", "1"])).toMatchObject({ ok: false, error: expect.stringMatching(/same address/) });
    expect(parseArgs(["--token", TOKEN, "--founder", FOUNDER, "--holder-min", "1e6"])).toMatchObject({ ok: false, error: expect.stringMatching(/--holder-min/) });
    expect(parseArgs(["--token", TOKEN, "--founder", FOUNDER])).toMatchObject({ ok: false, error: expect.stringMatching(/--holder-min/) });
    expect(parseArgs([...BASE, "--send"])).toMatchObject({ ok: false, error: "unknown argument: --send" });
    expect(parseArgs(["--token", "--founder", FOUNDER])).toMatchObject({ ok: false, error: "--token needs a value" });
  });

  it("normalizes amounts", () => {
    expect(normalizeAmount("0")).toBe("0");
    expect(normalizeAmount("000")).toBe("0");
    expect(normalizeAmount("2.50")).toBe("2.5");
    expect(normalizeAmount("3.000")).toBe("3");
    expect(normalizeAmount("-1")).toBeNull();
    expect(normalizeAmount("1.")).toBeNull();
    expect(normalizeAmount("")).toBeNull();
  });
});

describe("README markers", () => {
  it("keep the heading of the old block and everything outside it", () => {
    const result = replaceMarked(README_TEXT, "New text.");
    expect(result).toEqual({
      ok: true,
      before: "## The HYVO token\n\nHyvo has not launched a token yet.",
      text: README_TEXT.replace("## The HYVO token\n\nHyvo has not launched a token yet.", "## The HYVO token\n\nNew text."),
    });
  });

  it("keep Windows line endings", () => {
    const result = replaceMarked(README_TEXT.replace(/\n/g, "\r\n"), "New text.");
    expect(result.ok && result.text.split("\r\n").length).toBe(README_TEXT.replace("Hyvo has not launched a token yet.", "New text.").split("\n").length);
    expect(result.ok && /[^\r]\n/.test(result.text)).toBe(false);
  });

  it("refuse markers that are missing, doubled or out of order", () => {
    expect(replaceMarked("# Hyvo\n", "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/^no /) });
    expect(replaceMarked(`${README_START}\n${README_START}\n${README_END}\n`, "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/once each/) });
    expect(replaceMarked(`${README_END}\n${README_START}\n`, "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/before the start/) });
  });

  it("the live text names the address twice, linked, and the token page", () => {
    const block = liveReadmeBlock(TOKEN, "https://robinhoodchain.blockscout.com", "https://hyvo.run");
    expect(block.split(TOKEN)).toHaveLength(3);
    expect(block).toContain("https://hyvo.run/token");
  });
});

describe("deploy guard", () => {
  const wrangler = readFileSync(join(API_DIR, "wrangler.jsonc"), "utf8");

  it("refuses payments with no admin to refund or pause", () => {
    expect(paymentsWithoutAdmin({ PAYMENT_ROUTER_ADDRESS: ROUTER, ADMIN_ADDRESSES: "" })).toMatch(/ADMIN_ADDRESSES names no wallet/);
    expect(paymentsWithoutAdmin({ PAYMENT_ROUTER_ADDRESS: ROUTER, ADMIN_ADDRESSES: " , not-an-address" })).toMatch(/ADMIN_ADDRESSES/);
    expect(paymentsWithoutAdmin({ PAYMENT_ROUTER_ADDRESS: ROUTER })).toMatch(/ADMIN_ADDRESSES/);
    expect(paymentsWithoutAdmin({ PAYMENT_ROUTER_ADDRESS: ROUTER, ADMIN_ADDRESSES: `junk,${FOUNDER}` })).toBeNull();
    expect(paymentsWithoutAdmin({ PAYMENT_ROUTER_ADDRESS: "", ADMIN_ADDRESSES: "" })).toBeNull();
    expect(paymentsWithoutAdmin({ PAYMENT_ROUTER_ADDRESS: zeroAddress, ADMIN_ADDRESSES: "" })).toBeNull();
  });

  it("reads what the Worker gets: wrangler.jsonc, with production.vars.json on top", () => {
    const base = effectiveVars(wrangler, {}, GUARDED_VARS);
    expect(Object.keys(base).sort()).toEqual([...GUARDED_VARS].sort());
    expect(paymentsWithoutAdmin(effectiveVars(wrangler, { PAYMENT_ROUTER_ADDRESS: ROUTER }, GUARDED_VARS))).not.toBeNull();
    expect(paymentsWithoutAdmin(effectiveVars(wrangler, { PAYMENT_ROUTER_ADDRESS: ROUTER, ADMIN_ADDRESSES: FOUNDER }, GUARDED_VARS))).toBeNull();
    // The repo's own settings deploy.
    const production = JSON.parse(readFileSync(join(API_DIR, "production.vars.json"), "utf8")) as Record<string, string>;
    expect(paymentsWithoutAdmin(effectiveVars(wrangler, production, GUARDED_VARS))).toBeNull();
  });
});

describe("the CLI", () => {
  const tsx = join(API_DIR, "node_modules", "tsx", "dist", "cli.mjs");

  it("prints the usage and exits 2 on bad arguments, before reading anything", () => {
    const result = spawnSync(process.execPath, [tsx, join(HERE, "token-go-live.ts"), "--", "--token", "nope"], { cwd: API_DIR, encoding: "utf8", timeout: 60_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(2);
    expect(result.stderr).toMatch(/--token must be the token's contract address/);
    expect(result.stderr).toMatch(/Usage: pnpm --filter @hyvo\/api token:go-live/);
  });
});
