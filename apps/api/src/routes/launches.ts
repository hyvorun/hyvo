import { Hono } from "hono";
import type { AppEnv } from "../env";
import { checkClient } from "../lib/check";
import { nowS } from "../lib/clock";
import { creatorLaunches } from "../lib/creator";

/**
 * `/v1/launches/creator/:address`: every Pons V2 launch by one wallet, from the factory's TokenLaunched logs in
 * Blockscout's index, read with the Worker's key (docs/API.md, "Hyvo Launches"). Facts from the logs, not a rating of
 * the wallet and not a trading signal; the web app reads each launch's state now from the chain.
 */
export const launches = new Hono<AppEnv>();

const JSON_TYPE = "application/json; charset=utf-8";

launches.get("/creator/:address", async (c) => {
  const answer = await creatorLaunches(c.env, c.req.param("address"), checkClient(c), nowS());
  return c.body(answer.text, 200, {
    "Content-Type": JSON_TYPE,
    // An answer with a part Blockscout did not give is not kept, here or in the browser.
    "Cache-Control": answer.maxAgeS > 0 ? `public, max-age=${answer.maxAgeS}` : "no-store",
    "X-Hyvo-Cache": answer.hit ? "hit" : "miss",
  });
});
