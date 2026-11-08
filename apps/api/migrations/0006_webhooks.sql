-- Phase 5: webhooks for bots. A delivery is one event for one webhook, tried again with growing waits by the cron.
-- A webhook's signing secret is derived from a Worker secret and its id, so none is stored here.

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,                 -- 'wh_…'
  address TEXT NOT NULL,               -- the wallet it belongs to
  url TEXT NOT NULL,
  events TEXT NOT NULL,                -- JSON list of event types
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,                 -- too many failures in a row, or deleted
  failed_in_a_row INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX webhooks_by_address ON webhooks (address, created_at DESC);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,                 -- 'whd_…', sent as X-Hyvo-Delivery
  webhook_id TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,                  -- the exact JSON that is signed and sent
  status TEXT NOT NULL,                -- 'pending' | 'delivered' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,            -- also the claim: a sender moves it forward before it sends
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_at);
CREATE INDEX webhook_deliveries_by_webhook ON webhook_deliveries (webhook_id, created_at DESC);
