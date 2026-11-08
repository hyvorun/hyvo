-- Phase 6: dApp Dry Run. A job is a run or a Dry Run. A Dry Run's report stays private to the wallet that asked for it, so it
-- never enters `runs` or the gallery, and nothing about it goes on-chain.
ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run';  -- 'run' | 'dryrun'
ALTER TABLE jobs ADD COLUMN report_json TEXT;                  -- a Dry Run's summary (DryRunSummary)
ALTER TABLE jobs ADD COLUMN artifact_key TEXT;                 -- where a Dry Run's dryrun.json is
CREATE INDEX jobs_by_kind ON jobs (kind, address, created_at DESC);
