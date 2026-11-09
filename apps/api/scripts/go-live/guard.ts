/**
 * What the deploy script refuses before it touches the account. The Worker reads these values as
 * apps/api/src/lib/config.ts does: an address counts when it is valid and not zero, and ADMIN_ADDRESSES
 * counts only its valid addresses.
 */
import { addressOrNull } from "./contracts";

/** The vars the deployed Worker gets: wrangler.jsonc's, then apps/api/production.vars.json on top. */
export function effectiveVars(wranglerText: string, production: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(wranglerText);
    if (match) vars[key] = match[1]!;
  }
  for (const key of keys) if (typeof production[key] === "string") vars[key] = production[key]!;
  return vars;
}

export const GUARDED_VARS = ["PAYMENT_ROUTER_ADDRESS", "ADMIN_ADDRESSES"] as const;

/**
 * Payments open (PAYMENT_ROUTER_ADDRESS set) with nobody able to open /admin means nobody can record a refund
 * or pause the queue. The reason to refuse, or null.
 */
export function paymentsWithoutAdmin(vars: Record<string, string | undefined>): string | null {
  if (!addressOrNull(vars.PAYMENT_ROUTER_ADDRESS)) return null;
  const admins = (vars.ADMIN_ADDRESSES ?? "")
    .split(",")
    .map((item) => addressOrNull(item))
    .filter(Boolean);
  if (admins.length > 0) return null;
  return (
    "PAYMENT_ROUTER_ADDRESS is set but ADMIN_ADDRESSES names no wallet: with payments open nobody could record a refund " +
    "or pause the queue in /admin. Add the founder's wallet to ADMIN_ADDRESSES in apps/api/production.vars.json " +
    "(token:go-live --open-payments --write does it), or remove PAYMENT_ROUTER_ADDRESS."
  );
}
