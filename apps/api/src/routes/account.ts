import { SiweVerifyRequest } from "@hyvo/schema";
import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../env";
import { bearer, endSession, issueNonce, requireSession, verifySiwe } from "../lib/auth";
import { nowS } from "../lib/clock";
import { config } from "../lib/config";
import { readJson } from "../lib/errors";
import { holderStatus } from "../lib/holder";
import { clientIp, rateLimit } from "../lib/ratelimit";

/** `/v1/auth`: Sign-In with Ethereum. */
export const auth = new Hono<AppEnv>();

auth.post("/siwe/nonce", async (c) => {
  const now = nowS();
  await rateLimit(c.env.DB, "nonce", clientIp(c), 30, 60, now);
  return c.json(await issueNonce(c.env.DB, now), 201);
});

auth.post("/siwe/verify", async (c) => {
  const now = nowS();
  await rateLimit(c.env.DB, "verify", clientIp(c), 30, 60, now);
  const body = await readJson(c, SiweVerifyRequest);
  return c.json(await verifySiwe(c.env.DB, config(c.env), body.message, body.signature as Hex, now), 201);
});

auth.post("/logout", requireSession, async (c) => {
  await endSession(c.env.DB, bearer(c.req.header("Authorization")));
  return c.json({ ok: true as const });
});

/** `/v1/me`: the signed-in wallet and its holder benefits. */
export const me = new Hono<AppEnv>();

me.get("/", requireSession, async (c) => {
  const cfg = config(c.env);
  const address = c.get("address");
  // The holder status reads the chain.
  await rateLimit(c.env.DB, "me", address, 30, 60, nowS());
  return c.json({
    address,
    admin: cfg.admins.has(address.toLowerCase()),
    holder: await holderStatus(c.env.DB, cfg, address, nowS()),
  });
});
