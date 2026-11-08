-- Phase 5: API keys for bots and prepaid balances. A balance is an accounting entry: the funds went to the
-- treasury through PaymentRouter (SPEC 8.5). Amounts are micro-USD, which are USDG's base units, as integers.

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                 -- 'key_…', safe to show
  key_hash TEXT NOT NULL UNIQUE,       -- SHA-256 of the key; the key itself is shown once
  prefix TEXT NOT NULL,                -- its first characters, so a person can tell keys apart
  address TEXT NOT NULL,               -- the wallet whose balance it spends
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_keys_by_address ON api_keys (address, created_at DESC);

CREATE TABLE balances (
  address TEXT PRIMARY KEY,
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0)
);

-- Every change to a balance, so a balance can be explained line by line.
CREATE TABLE balance_entries (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  delta_micros INTEGER NOT NULL,
  reason TEXT NOT NULL,                -- 'topup' | 'run' | 'run_failed' | 'ask' | 'ask_returned'
  run_id TEXT,
  order_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX balance_entries_by_address ON balance_entries (address, created_at DESC);

-- A top-up shares PaymentRouter's orderId space with `orders`.
CREATE TABLE topups (
  order_id TEXT PRIMARY KEY,           -- 0x + 64 hex, the PaymentRouter orderId
  address TEXT NOT NULL,               -- the wallet that gets the credit, whoever pays
  token TEXT NOT NULL,
  amount TEXT NOT NULL,                -- what was asked for, in base units
  status TEXT NOT NULL,                -- 'quoted' | 'paid'
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  payment_id TEXT,
  credited_micros INTEGER
);
CREATE INDEX topups_by_address ON topups (address, created_at DESC);

-- A job paid from a balance: what it cost, returned if the run fails, and the caller's id for the request, so a bot
-- that retries after a lost answer does not pay twice.
ALTER TABLE jobs ADD COLUMN charged_micros INTEGER;
ALTER TABLE jobs ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX jobs_by_request ON jobs (address, request_id) WHERE request_id IS NOT NULL;
