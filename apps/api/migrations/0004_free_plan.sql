-- Workers Free plan (docs/OPEN_ITEMS.md item 21): run.json lives in Workers KV, and a job records
-- what its upload was, because KV reads can lag right after a write.
ALTER TABLE runs RENAME COLUMN r2_key TO artifact_key;
ALTER TABLE jobs ADD COLUMN upload_sha256 TEXT;
ALTER TABLE jobs ADD COLUMN upload_size INTEGER;
-- The run hash, when VERIFY_RUNS_IN_WORKER=1 re-hashes the upload (needs Workers Paid).
ALTER TABLE jobs ADD COLUMN upload_hash TEXT;
