-- Phase 7: Wallet Clone (SPEC 11.3). A wallet's own statistics, built only after it signs in, and gone when it asks. Numbers only: the address is the
-- key, and it never leaves this table except to the runner that reads that wallet's history.
CREATE TABLE clones (
  address TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- 'building' | 'ready' | 'failed'
  profile_json TEXT,             -- CloneProfile
  error TEXT,
  run_id TEXT NOT NULL,          -- the job that builds it; a job for an older or deleted clone changes nothing
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
