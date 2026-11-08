-- Phase 3: sign-in, orders and payments, the runner queue, refunds and oracle commits.
-- Times are Unix seconds (UTC). Addresses are lowercase 0x hex. Token amounts are base units as
-- decimal strings, so no precision is lost.

-- Gallery visibility: unlisted runs open by link but stay out of GET /v1/runs.
ALTER TABLE runs ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;
DROP INDEX runs_by_published;
CREATE INDEX runs_by_published ON runs (listed, published_at DESC, run_id DESC);

-- Sign-In with Ethereum: single-use nonces, then sessions (only the token's SHA-256 is kept).
CREATE TABLE siwe_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_expiry ON sessions (expires_at);

-- A quote is an order: the run it buys is fixed when it is quoted.
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,           -- 0x + 64 hex, the PaymentRouter orderId
  address TEXT NOT NULL,               -- the signed-in wallet that asked for it
  spec_json TEXT NOT NULL,             -- JobSpec (packages/schema/src/jobs.ts)
  title TEXT NOT NULL,
  listed INTEGER NOT NULL,
  token TEXT NOT NULL,                 -- payment token
  amount TEXT NOT NULL,
  price_usd REAL NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  discount_bps INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL,                -- 'quoted' | 'paid' (expiry is read from expires_at)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  payment_id TEXT,
  run_id TEXT
);
CREATE INDEX orders_by_address ON orders (address, created_at DESC);

-- Every PaymentRouter.Paid event seen, matched to an order or not.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,                 -- '<txHash>:<logIndex>'
  order_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,            -- the event's timestamp
  matched INTEGER NOT NULL,
  note TEXT,                           -- why it did not pay its order
  seen_at INTEGER NOT NULL
);
CREATE INDEX payments_by_order ON payments (order_id);
CREATE INDEX payments_by_time ON payments (paid_at);

-- The runner queue. A job is created only from a paid order or a used holder credit.
CREATE TABLE jobs (
  run_id TEXT PRIMARY KEY,
  order_id TEXT,
  address TEXT,
  source TEXT NOT NULL,                -- 'paid' | 'credit'
  spec_json TEXT NOT NULL,
  title TEXT NOT NULL,
  listed INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL,                -- 'queued' | 'running' | 'complete' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  leased_at INTEGER,
  heartbeat_at INTEGER,
  progress_round INTEGER,
  rounds INTEGER NOT NULL,
  max_cost_usd REAL NOT NULL,
  timeout_s INTEGER NOT NULL,
  cost_usd REAL,                       -- usage.costUsd of the published run
  run_hash TEXT,
  run_status TEXT,                     -- 'complete' | 'partial' (run.json status)
  fail_reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX jobs_by_queue ON jobs (status, priority DESC, created_at);
CREATE INDEX jobs_by_finish ON jobs (finished_at);

-- LLM spend per attempt, for the global daily cap: the job's maxCostUsd is reserved when an
-- attempt starts and replaced by the real cost when its run is published.
CREATE TABLE spend (
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  day TEXT NOT NULL,                   -- 'YYYY-MM-DD' (UTC) of the attempt's start
  amount_usd REAL NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, attempt)
);
CREATE INDEX spend_by_day ON spend (day);

-- Refunds owed to payers. They are sent by hand from the treasury and recorded here
-- (docs/RUNBOOK.md); nothing here moves funds.
CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,                -- 'run_failed' | 'payment_unmatched' | 'overpaid'
  run_id TEXT,
  order_id TEXT,
  payment_id TEXT,
  address TEXT NOT NULL,               -- who gets it back: the payer
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,                -- 'due' | 'sent'
  tx_hash TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE UNIQUE INDEX refunds_once ON refunds (reason, COALESCE(run_id, ''), COALESCE(payment_id, ''));
CREATE INDEX refunds_by_status ON refunds (status, created_at);

-- HyvoOracle commits sent with the attester key.
CREATE TABLE oracle_commits (
  run_id TEXT PRIMARY KEY,
  run_id_bytes32 TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  scenario_hash TEXT NOT NULL,
  status TEXT NOT NULL,                -- 'pending' | 'sent' | 'confirmed' | 'failed'
  tx_hash TEXT,
  block_number INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE INDEX oracle_by_status ON oracle_commits (status, updated_at);
CREATE INDEX oracle_by_created ON oracle_commits (created_at DESC, run_id DESC);

-- Holder free runs used per wallet and calendar month (UTC).
CREATE TABLE credit_usage (
  address TEXT NOT NULL,
  month TEXT NOT NULL,                 -- 'YYYY-MM'
  used INTEGER NOT NULL,
  PRIMARY KEY (address, month)
);

-- Small state: the payment scan cursor, the queue pause flag.
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Fixed-window rate limit counters ('<scope>:<who>:<window start>').
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX rate_limits_by_window ON rate_limits (window_start);
