import { Hono } from "hono";
import type { AppEnv } from "../env";
import { checkClient, tokenCheck } from "../lib/check";
import { nowS } from "../lib/clock";

/**
 * `/v1/check/:token`: Hyvo Check, a token's facts at one block with their evidence, and an exit simulation in one
 * read-only eth_call (docs/API.md, "Hyvo Check"). Facts, not a verdict about the token and not a trading signal.
 */
export const check = new Hono<AppEnv>();

check.get("/:token", async (c) => {
  const answer = await tokenCheck(c.env, c.req.param("token"), checkClient(c), nowS());
  return c.body(answer.text, 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${answer.maxAgeS}`,
    "X-Hyvo-Cache": answer.hit ? "hit" : "miss",
  });
});
