/**
 * Puts Hyvo on Cloudflare's free plans, in one command (docs/RUNBOOK.md, "Going live"):
 *
 *   pnpm --filter @hyvo/api deploy:cloudflare             what would happen, nothing changes
 *   pnpm --filter @hyvo/api deploy:cloudflare --yes       do it
 *
 * It creates the D1 database and the KV namespace if they are missing and writes their ids to
 * wrangler.jsonc, applies the migrations, generates the Worker's secrets and writes the runner's
 * settings to the repo's .env (gitignored), deploys the Worker and the web app, publishes the
 * showcase run if nothing is featured yet, and checks the result from outside. It can run again: what exists is kept. It only
 * touches only the resources named below.
 *
 * Options: --pages-project NAME (default hyvo).
 *
 * Custom domains come from apps/api/domains.json: the site is served at `web` (and `webAlso`, which
 * send visitors to `web`) by the assets-only Worker in apps/web/wrangler.jsonc, and the API gets `api`.
 * Wrangler attaches both. Without the file the site stays on *.pages.dev and the API on *.workers.dev;
 * with it, *.pages.dev keeps working and sends visitors to `web`.
 */
import { hashRun, RunV1 } from "@hyvo/schema";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveVars, GUARDED_VARS, paymentsWithoutAdmin } from "./go-live/guard";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const REPO = resolve(API_DIR, "..", "..");
const WEB_DIR = join(REPO, "apps", "web");
const ENGINE = join(REPO, "engine");
const ENV_FILE = join(REPO, ".env");
const CONFIG = join(API_DIR, "wrangler.jsonc");
const WRANGLER = join(API_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const SHOWCASE = join(REPO, "fixtures", "showcase-run.json");
const DEPLOYMENT = join(REPO, "chain", "deployments", "4663.json");
const DOMAINS = join(API_DIR, "domains.json");
const WEB_WORKER_CONFIG = join(WEB_DIR, "wrangler.jsonc");

const DATABASE = "hyvo";
const NAMESPACE = "hyvo-artifacts";
const WORKER = "hyvo-api";
const AGENTS_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const REPORT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/**
 * With an OpenRouter key in the repo's .env, the runner plays runs on DeepSeek V4 Flash there instead of Workers AI's free
 * allowance (founder, 2026-11-09: about 1 run a day fits the free allowance). The engine caps each call's price at the one it
 * budgets with (engine/hyvo/llm/pricing.py), so the founder's credit is never charged more than a run records.
 */
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";

const argv = process.argv.slice(2);
const YES = argv.includes("--yes");
const pagesIndex = argv.indexOf("--pages-project");
const PAGES = pagesIndex >= 0 ? argv[pagesIndex + 1]! : "hyvo";

function say(step: string, detail = ""): void {
  console.log(`[deploy] ${step}${detail ? `: ${detail}` : ""}`);
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: options.cwd ?? API_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", ...options.env },
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function wranglerRun(args: string[], options: { input?: string } = {}): SpawnSyncReturns<string> {
  const result = run(process.execPath, [WRANGLER, ...args], options);
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed:\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500)}`);
  }
  return result;
}

function wrangler(args: string[], options: { input?: string } = {}): string {
  const result = wranglerRun(args, options);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** A listing Wrangler prints as JSON. Warnings go to stderr, and they contain brackets. */
function wranglerList<T>(args: string[]): T[] {
  const output = wranglerRun(args).stdout ?? "";
  return JSON.parse(output.slice(output.indexOf("["), output.lastIndexOf("]") + 1)) as T[];
}

/** Read the repo's .env as a map, keeping the file's own text so comments survive. */
function readEnv(): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return values;
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

function writeEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : ["# Written by scripts/deploy-cloudflare.ts. Never commit this file."];
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const name = /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];
    if (!name || !pending.has(name)) return line;
    const value = pending.get(name)!;
    pending.delete(name);
    return `${name}=${value}`;
  });
  for (const [name, value] of pending) next.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, `${next.join("\n").replace(/\n+$/, "")}\n`);
}

/**
 * The custom domains (docs/OPEN_ITEMS.md item 9), all attached by `wrangler deploy --domain`: `web` and
 * `webAlso` to the web Worker, `api` to the API Worker. A key that is missing or not a hostname keeps the
 * free *.pages.dev or *.workers.dev address.
 */
function readDomains(): { web?: string; webAlso: string[]; api?: string } {
  if (!existsSync(DOMAINS)) return { webAlso: [] };
  const parsed = JSON.parse(readFileSync(DOMAINS, "utf8")) as Record<string, unknown>;
  const host = (value: unknown) => (typeof value === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? value : undefined);
  const web = host(parsed.web);
  const webAlso = web && Array.isArray(parsed.webAlso) ? parsed.webAlso.map(host).filter((name): name is string => Boolean(name)) : [];
  return { web, webAlso, api: host(parsed.api) };
}

function secret(existing: string | undefined): string {
  return existing?.trim() || randomBytes(32).toString("hex");
}

function patchConfig(databaseId: string, namespaceId: string): void {
  const text = readFileSync(CONFIG, "utf8")
    .replace(/"database_id": "[^"]*"/, `"database_id": "${databaseId}"`)
    .replace(/("binding": "ARTIFACTS", "id": )"[^"]*"/, `$1"${namespaceId}"`);
  writeFileSync(CONFIG, text);
}

/**
 * GET a URL. A brand-new domain can be live for the world while this machine's resolver still caches "no such
 * name" (up to the zone's negative TTL), so when the name does not resolve here, curl asks over DNS-over-HTTPS.
 */
async function get(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const response = await fetch(url);
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    const result = run("curl", ["-s", "-m", "30", "-w", "\n%{http_code}", "--doh-url", "https://cloudflare-dns.com/dns-query", url]);
    const cut = result.stdout.lastIndexOf("\n");
    const status = Number(result.stdout.slice(cut + 1));
    if (result.status !== 0 || !status) throw error;
    return { ok: status >= 200 && status < 300, status, text: result.stdout.slice(0, cut) };
  }
}

/** Keep asking: a new hostname, a Pages deployment and a KV write all take a moment to be everywhere. */
async function settled(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 180_000;
  let problem = "unexpected answer";
  for (;;) {
    try {
      if (await check()) {
        say("checked", what);
        return;
      }
      problem = "unexpected answer";
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`${what}: ${problem}`);
    await new Promise((done) => setTimeout(done, 5_000));
  }
}

/**
 * What a visitor gets, from outside Cloudflare: the API, the web app, and the featured run with its
 * hash recomputed from the published bytes. Which run is featured is a decision made elsewhere: a
 * deploy of new code only checks that it is intact.
 */
async function checkLive(apiUrl: string, webOrigin: string): Promise<void> {
  const json = async (url: string) => {
    const response = await get(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return JSON.parse(response.text) as Record<string, any>;
  };
  await settled("the API answers", async () => (await json(`${apiUrl}/v1/health`)).ok === true);
  await settled("the featured run is intact", async () => {
    const { run } = await json(`${apiUrl}/v1/runs/featured`);
    if (!run) return false;
    const { url } = await json(`${apiUrl}/v1/runs/${run.runId}/artifact`);
    const response = await get(url as string);
    return response.ok && hashRun(RunV1.parse(JSON.parse(response.text))) === run.hash;
  });
  await settled("the web app answers", async () => (await get(webOrigin)).ok);
}

async function main(): Promise<void> {
  // Before anything else, in a dry run too: open payments with no admin could be neither refunded nor paused.
  const productionVars = JSON.parse(readFileSync(join(API_DIR, "production.vars.json"), "utf8")) as Record<string, string>;
  const refusal = paymentsWithoutAdmin(effectiveVars(readFileSync(CONFIG, "utf8"), productionVars, GUARDED_VARS));
  if (refusal) throw new Error(refusal);

  const whoami = wrangler(["whoami"]);
  const account = /associated with the email ([^\s.]+@[^\s]+?)\.?\s/.exec(whoami)?.[1] ?? "unknown";
  say("Cloudflare account", account);

  // The bundle is checked first, on every run: a broken build must not get as far as the account.
  const bundle = wrangler(["deploy", "--dry-run", "--outdir", join(API_DIR, ".wrangler", "dry-run")]);
  say("Worker bundle", /Total Upload: [^\n]*/.exec(bundle)?.[0] ?? "built");

  if (!YES) {
    say("dry run: nothing was changed. With --yes this would:");
    for (const step of [
      `create D1 database "${DATABASE}" and KV namespace "${NAMESPACE}" if missing, and write their ids to apps/api/wrangler.jsonc`,
      "apply the D1 migrations to the remote database",
      `set the secrets RUNNER_TOKEN, LLM_TOKEN and ARTIFACT_SIGNING_KEY on Worker "${WORKER}" (generated once, kept in the repo's .env)`,
      `deploy Worker "${WORKER}" and Pages project "${PAGES}" (free plans, *.workers.dev and *.pages.dev, or the domains in apps/api/domains.json)`,
      "write the runner's settings to .env, publish the showcase run if nothing is featured yet, and check it all from outside",
    ]) {
      console.log(`  - ${step}`);
    }
    return;
  }

  // --- storage -----------------------------------------------------------------------------------
  const databases = wranglerList<{ name: string; uuid: string }>(["d1", "list", "--json"]);
  let databaseId = databases.find((db) => db.name === DATABASE)?.uuid;
  if (!databaseId) {
    const created = wrangler(["d1", "create", DATABASE]);
    databaseId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(created)?.[0];
    if (!databaseId) throw new Error(`no database id in:\n${created}`);
    say("created D1 database", DATABASE);
  }
  const findNamespace = () => wranglerList<{ id: string; title: string }>(["kv", "namespace", "list"]).find((ns) => ns.title === NAMESPACE)?.id;
  let namespaceId = findNamespace();
  if (!namespaceId) {
    wrangler(["kv", "namespace", "create", NAMESPACE]);
    namespaceId = findNamespace();
    if (!namespaceId) throw new Error(`KV namespace ${NAMESPACE} was not created`);
    say("created KV namespace", NAMESPACE);
  }
  patchConfig(databaseId, namespaceId);
  wrangler(["d1", "migrations", "apply", DATABASE, "--remote"]);
  say("migrations applied");

  // --- web project first: its URL is the Worker's CORS origin and SIWE domain ---------------------
  const projectsOf = () => wranglerList<Record<string, string>>(["pages", "project", "list", "--json"]);
  const named = (rows: Record<string, string>[]) => rows.find((row) => (row["Project Name"] ?? row.name) === PAGES);
  if (!named(projectsOf())) {
    // --force: in an agent session Wrangler otherwise deploys the current folder as a Worker named after the project.
    wrangler(["pages", "project", "create", PAGES, "--production-branch", "main", "--force"]);
    say("created Pages project", PAGES);
  }
  const project = named(projectsOf());
  if (!project) throw new Error(`Pages project "${PAGES}" is not on the account after creating it`);
  const domains = String(project["Project Domains"] ?? project.domains ?? `${PAGES}.pages.dev`);
  const pagesHost = /[a-z0-9-]+\.pages\.dev/.exec(domains)?.[0] ?? `${PAGES}.pages.dev`;
  const custom = readDomains();
  const webHost = custom.web ?? pagesHost;
  const webOrigin = `https://${webHost}`;
  // While the site has its own domain, *.pages.dev still serves it (and sends visitors on), so the API accepts both.
  const siteHosts = custom.web ? [custom.web, pagesHost] : [pagesHost];

  // --- the Worker -----------------------------------------------------------------------------------
  const env = readEnv();
  const runnerToken = secret(env.get("RUNNER_TOKEN"));
  const llmToken = secret(env.get("LLM_TOKEN"));
  const signingKey = secret(env.get("ARTIFACT_SIGNING_KEY"));
  const production = JSON.parse(readFileSync(join(API_DIR, "production.vars.json"), "utf8")) as Record<string, string>;
  const vars: Record<string, string> = {
    ...production,
    WEB_ORIGIN: siteHosts.map((host) => `https://${host}`).join(","),
    SIWE_DOMAIN: siteHosts.join(","),
  };
  delete vars["//"];
  const deployWorker = (settings: Record<string, string>) =>
    wrangler(["deploy", ...(custom.api ? ["--domain", custom.api] : []), ...Object.entries(settings).flatMap(([key, value]) => ["--var", `${key}:${value}`])]);
  const deployed = deployWorker(vars);
  let apiUrl = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployed)?.[0];
  if (custom.api) {
    // A new custom domain waits for its certificate. Until it answers, everything keeps the workers.dev address.
    try {
      await settled(`${custom.api} answers`, async () => (await get(`https://${custom.api}/v1/health`)).ok);
      apiUrl = `https://${custom.api}`;
    } catch (error) {
      if (!apiUrl) throw error;
      say("API stays on workers.dev for now", `${custom.api} does not answer yet (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!apiUrl) throw new Error(`no API address in the deploy output:
${deployed.slice(-800)}`);
  // The cron needs the Worker's own address for links that go on-chain. A new account only learns it here.
  if (vars.PUBLIC_API_URL !== apiUrl) deployWorker({ ...vars, PUBLIC_API_URL: apiUrl });
  say("Worker deployed", apiUrl);
  wrangler(["secret", "put", "RUNNER_TOKEN"], { input: runnerToken });
  wrangler(["secret", "put", "LLM_TOKEN"], { input: llmToken });
  wrangler(["secret", "put", "ARTIFACT_SIGNING_KEY"], { input: signingKey });
  // The founder's Blockscout key (docs/OPEN_ITEMS.md item 24), when the repo's .env has one: the Worker reads token holders with it.
  const blockscoutKey = env.get("BLOCKSCOUT_API_KEY")?.trim();
  if (blockscoutKey) wrangler(["secret", "put", "BLOCKSCOUT_API_KEY"], { input: blockscoutKey });
  say("secrets set");

  const openRouterKey = env.get("OPENROUTER_API_KEY")?.trim();
  writeEnv({
    RUNNER_TOKEN: runnerToken,
    LLM_TOKEN: llmToken,
    ARTIFACT_SIGNING_KEY: signingKey,
    HYVO_API_URL: apiUrl,
    ...(openRouterKey
      ? { LLM_API_KEY: openRouterKey, LLM_BASE_URL: OPENROUTER_URL, LLM_MODEL_NAME: OPENROUTER_MODEL, REPORT_MODEL_NAME: OPENROUTER_MODEL }
      : { LLM_API_KEY: llmToken, LLM_BASE_URL: `${apiUrl}/internal/llm/v1`, LLM_MODEL_NAME: AGENTS_MODEL, REPORT_MODEL_NAME: REPORT_MODEL }),
  });
  say("runner settings written", openRouterKey ? `.env (runs on ${OPENROUTER_MODEL} through OpenRouter)` : ".env");

  // --- the web app ----------------------------------------------------------------------------------
  // The web app pins the oracle it checks against, so /oracle does not have to take the API's word for it,
  // and /trust and /token read the other contracts from the chain at the addresses in the deployment file.
  const deployment = existsSync(DEPLOYMENT)
    ? (JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as { oracle?: string; paymentRouter?: string; usdg?: string; hyvoToken?: string })
    : null;
  const pinned = {
    VITE_ORACLE_ADDRESS: process.env.VITE_ORACLE_ADDRESS ?? deployment?.oracle,
    VITE_PAYMENT_ROUTER_ADDRESS: process.env.VITE_PAYMENT_ROUTER_ADDRESS ?? deployment?.paymentRouter,
    VITE_USDG_ADDRESS: process.env.VITE_USDG_ADDRESS ?? deployment?.usdg,
    VITE_HYVO_TOKEN_ADDRESS: process.env.VITE_HYVO_TOKEN_ADDRESS ?? deployment?.hyvoToken,
  };
  const site = custom.web
    ? { VITE_SITE_URL: webOrigin, VITE_SITE_HOST: custom.web, VITE_SITE_REDIRECT_HOSTS: [pagesHost, ...custom.webAlso].join(",") }
    : {};
  const webEnv = { VITE_API_URL: apiUrl, ...site, ...Object.fromEntries(Object.entries(pinned).filter(([, value]) => Boolean(value))) };
  const built = run(process.execPath, [join(WEB_DIR, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: WEB_DIR, env: webEnv });
  if (built.status !== 0) throw new Error(`the web build failed:\n${`${built.stdout}${built.stderr}`.slice(-1500)}`);
  if (custom.web) {
    // The domain first, and only then *.pages.dev, which from this build on sends visitors to it.
    wrangler(["deploy", "--config", WEB_WORKER_CONFIG, ...[custom.web, ...custom.webAlso].flatMap((name) => ["--domain", name])]);
    const entry = /src="(\/assets\/[^"]+\.js)"/.exec(readFileSync(join(WEB_DIR, "dist", "index.html"), "utf8"))?.[1] ?? "";
    await settled(`${custom.web} serves this build`, async () => (await get(`${webOrigin}/`)).text.includes(entry));
    say("web app deployed", webOrigin);
  }
  wrangler(["pages", "deploy", join(WEB_DIR, "dist"), "--project-name", PAGES, "--branch", "main", "--commit-dirty=true"]);
  say("web app deployed", `https://${pagesHost}`);

  // --- the showcase run and the check ---------------------------------------------------------------
  // A new account starts with the showcase run. After that a deploy of new code publishes nothing:
  // which run is featured is a decision made elsewhere, and publishing commits a run on-chain, which
  // cannot be undone. A version with new secrets takes a moment to reach every location.
  let nothingFeatured = false;
  await settled("the API answers", async () => {
    const response = await get(`${apiUrl}/v1/runs/featured`);
    nothingFeatured = response.status === 404;
    return response.ok || nothingFeatured;
  });
  if (nothingFeatured) {
    await settled("the showcase run is published", async () => {
      // ENGINE_PYTHON: for a machine where Application Control blocks the venv's python.exe (docs/RUNBOOK.md).
      const [python, ...prefix] = process.env.ENGINE_PYTHON ? [process.env.ENGINE_PYTHON] : ["uv", "run", "python"];
      const published = run(python!, [...prefix, "-m", "hyvo", "publish", SHOWCASE, "--api", apiUrl, "--featured"], {
        cwd: ENGINE,
        env: { RUNNER_TOKEN: runnerToken, PYTHONUTF8: "1" },
      });
      if (published.status !== 0) throw new Error(`${published.stdout}${published.stderr}`.slice(-800));
      return true;
    });
  }

  await checkLive(apiUrl, webOrigin);

  console.log(`\nHyvo is on Cloudflare.\n  web    ${webOrigin}\n  API    ${apiUrl}\n  runner cd engine && uv run python -m hyvo runner\n`);
}

try {
  await main();
} catch (error) {
  console.error(`[deploy] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
