/**
 * Switches Hyvo to the launched HYVO token (docs/RUNBOOK.md, "Launch day"):
 *
 *   pnpm --filter @hyvo/api token:go-live -- --token <CA> --founder <wallet> --holder-min <whole HYVO>           dry run
 *   pnpm --filter @hyvo/api token:go-live -- --token <CA> --founder <wallet> --holder-min <n> --open-payments --write
 *
 * It reads the token from Robinhood Chain through the public endpoints in apps/api/production.vars.json (RPC_URLS):
 * that it has code, its name, symbol, decimals and supply, and the Pons V2 factory's record of it, and refuses
 * unless the factory names the founder's wallet as its creator (--force overrides). With --open-payments it also
 * refuses unless PaymentRouter's treasury is already the founder's wallet (scripts/move-ownership.ts). With
 * --write it writes chain/deployments/4663.json, apps/api/production.vars.json and README.md, and then the
 * deploy script (scripts/deploy-cloudflare.ts) carries the values to the Worker and the web app.
 *
 * It only reads the chain: it never signs or sends a transaction.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goLive, parseArgs, USAGE } from "./go-live/token";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}

try {
  const code = await goLive(parsed.args, {
    io: {
      read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      write: (path, text) => writeFileSync(path, text),
    },
    paths: {
      deployment: join(REPO, "chain", "deployments", "4663.json"),
      productionVars: join(REPO, "apps", "api", "production.vars.json"),
      readme: join(REPO, "README.md"),
    },
    log: (line = "") => console.log(line),
  });
  process.exit(code);
} catch (error) {
  console.error(`[go-live] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
