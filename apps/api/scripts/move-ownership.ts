/**
 * Moves PaymentRouter's treasury and the ownership of PaymentRouter and HyvoOracle from the deployer wallet to
 * the founder's launch wallet (docs/OPEN_ITEMS.md item 12, docs/RUNBOOK.md "Launch day"):
 *
 *   pnpm --filter @hyvo/api move-ownership -- --founder <wallet>          the three calls, the state now, the gas
 *   pnpm --filter @hyvo/api move-ownership -- --founder <wallet> --send   sends them (the founder's approval first)
 *
 * With --send it loads DEPLOYER_PRIVATE_KEY from chain/.env at run time and never prints it. The founder's wallet
 * then calls acceptOwnership() on both contracts; until it does, nothing changes hands but the treasury.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { moveOwnership, OWNERSHIP_USAGE, parseOwnershipArgs } from "./go-live/ownership";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

const parsed = parseOwnershipArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\n\n${OWNERSHIP_USAGE}`);
  process.exit(2);
}

try {
  const code = await moveOwnership(parsed.args, {
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    log: (line = "") => console.log(line),
    paths: {
      deployment: join(REPO, "chain", "deployments", "4663.json"),
      productionVars: join(REPO, "apps", "api", "production.vars.json"),
      envFile: join(REPO, "chain", ".env"),
    },
    envFileName: "chain/.env",
  });
  process.exit(code);
} catch (error) {
  console.error(`[move-ownership] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
