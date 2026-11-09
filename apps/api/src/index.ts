/**
 * The Hyvo API Worker (docs/API.md): published runs from D1 and KV, signed artifact links,
 * Sign-In with Ethereum, quotes and payment detection, the runner job queue, oracle commits,
 * Hyvo Check, and the founder's admin view. Results are synthetic crowd reactions, not trading signals.
 */
// hono/quick: the default router compiles every route on the first request, and on the Workers Free plan that cost
// comes out of a cold isolate's 10 ms of CPU (docs/OPEN_ITEMS.md item 21). Sub-apps merge into this router.
import { Hono } from "hono/quick";
import { cors } from "hono/cors";
import type { AppEnv, Env } from "./env";
import { nowS } from "./lib/clock";
import { config, webOrigins } from "./lib/config";
import { ApiError, errorResponse } from "./lib/errors";
import { holderRequirement } from "./lib/holder";
import { maxDecisions } from "./lib/pricing";
import { auth, me } from "./routes/account";
import { admin } from "./routes/admin";
import { balance, keys } from "./routes/balance";
import { check } from "./routes/check";
import { dryruns } from "./routes/dryruns";
import { clones } from "./routes/clones";
import { internal, uploads } from "./routes/internal";
import { llm } from "./routes/llm";
import { mcp } from "./routes/mcp";
import { calibrationRoute, oracle } from "./routes/oracle";
import { orders, quotes } from "./routes/orders";
import { artifacts, runs } from "./routes/runs";
import { webhooks } from "./routes/webhooks";
import { runScheduled } from "./scheduled";

const app = new Hono<AppEnv>();

// Browser routes answer CORS only for the web app's origins.
app.use(
  "/v1/*",
  cors({
    origin: (origin, c) => (webOrigins(c.env).includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);

app.get("/v1/health", (c) => {
  const cfg = config(c.env);
  const { minAgents, maxAgents, minRounds, maxRounds } = cfg.sizes;
  const { multiplier, floorUsd, stepUsd, costPerAgentRoundUsd, reportCostUsd } = cfg.pricing;
  return c.json({
    ok: true as const,
    version: c.env.API_VERSION,
    features: cfg.features,
    limits: { minAgents, maxAgents, minRounds, maxRounds, maxDecisions: maxDecisions(cfg) },
    holder: holderRequirement(cfg),
    pricing: { multiplier, floorUsd, stepUsd, costPerAgentRoundUsd, reportCostUsd },
  });
});
app.route("/v1/auth", auth);
app.route("/v1/me", me);
app.route("/v1/keys", keys);
app.route("/v1/balance", balance);
app.route("/v1/webhooks", webhooks);
app.route("/v1/dryruns", dryruns);
app.route("/v1/quotes", quotes);
app.route("/v1/orders", orders);
app.route("/v1/runs", runs);
app.route("/v1/artifacts", artifacts);
app.route("/v1/oracle", oracle);
app.route("/v1/calibration", calibrationRoute);
app.route("/v1/clones", clones);
app.route("/v1/check", check);
app.route("/v1/admin", admin);
app.route("/mcp", mcp);
app.route("/internal/llm", llm);
app.route("/internal", internal);
app.route("/uploads", uploads);

app.notFound((c) => errorResponse(c, 404, "not_found", "no such endpoint"));
app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(c, error.status, error.code, error.message, error.retryAfterS);
  console.error(JSON.stringify({ level: "error", path: new URL(c.req.url).pathname, error: String(error).slice(0, 500) }));
  return errorResponse(c, 500, "internal", "unexpected error");
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, nowS()).then((report) => console.log(JSON.stringify({ level: "info", event: "cron", report }))));
  },
} satisfies ExportedHandler<Env>;
