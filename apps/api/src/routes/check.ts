import { Hono } from "hono";
import type { AppEnv } from "../env";
import { checkClient, tokenCheck } from "../lib/check";
import { nowS } from "../lib/clock";
import { tokenHolders } from "../lib/holders";

/**
 * `/v1/check/:token`: Hyvo Check, a token's facts at one block with their evidence, and an exit simulation in one
 * read-only eth_call (docs/API.md, "Hyvo Check"). Facts, not a verdict about the token and not a trading signal.
 * `/v1/check/:token/holders`: the token's top holders and creator from Blockscout's index, read with the Worker's
 * key, for the /check page that runs its check in the browser.
 */
export const check = new Hono<AppEnv>();

const JSON_TYPE = "application/json; charset=utf-8";

check.get("/:token", async (c) => {
  const answer = await tokenCheck(c.env, c.req.param("token"), checkClient(c), nowS());
  return c.body(answer.text, 200, {
    "Content-Type": JSON_TYPE,
    "Cache-Control": `public, max-age=${answer.maxAgeS}`,
    "X-Hyvo-Cache": answer.hit ? "hit" : "miss",
  });
});

check.get("/:token/holders", async (c) => {
  const answer = await tokenHolders(c.env, c.req.param("token"), checkClient(c), nowS());
  return c.body(answer.text, 200, {
    "Content-Type": JSON_TYPE,
    // Facts with a part Blockscout did not answer are not kept, here or in the browser.
    "Cache-Control": answer.maxAgeS > 0 ? `public, max-age=${answer.maxAgeS}` : "no-store",
    "X-Hyvo-Cache": answer.hit ? "hit" : "miss",
  });
});
