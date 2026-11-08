-- Phase 6: scenario questions. A commit carries the question's date, because HyvoOracle.resolve refuses a commit without one.
ALTER TABLE oracle_commits ADD COLUMN resolves_at INTEGER;

CREATE TABLE questions (
  run_id TEXT PRIMARY KEY,
  run_id_bytes32 TEXT NOT NULL,
  address TEXT,                        -- the wallet that started the run, when it has one
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  resolves_at INTEGER NOT NULL,
  expectation TEXT NOT NULL,           -- 'yes' | 'no' | 'split': hashed with the run, before the outcome is known
  yes INTEGER NOT NULL,
  no INTEGER NOT NULL,
  unsure INTEGER NOT NULL,
  listed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  outcome TEXT,                        -- 'yes' | 'no' | 'void'
  note TEXT,
  evidence_url TEXT,
  outcome_json TEXT,                   -- the exact bytes whose keccak-256 goes on-chain, served at /v1/runs/:id/outcome
  outcome_hash TEXT,
  decided_at INTEGER,
  status TEXT,                         -- on-chain: 'pending' | 'sent' | 'confirmed' | 'failed'
  tx_hash TEXT,
  block_number INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_attempt_at INTEGER,
  claimed_until INTEGER,
  updated_at INTEGER
);
CREATE INDEX questions_open ON questions (outcome, resolves_at);
CREATE INDEX questions_by_status ON questions (status, updated_at);
