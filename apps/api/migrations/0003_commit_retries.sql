-- Oracle commits: one processor at a time (a short claim), and retries with growing waits instead of
-- giving up. A NULL next_attempt_at on a failed commit means it is not retried: the chain holds
-- another hash for the run.
ALTER TABLE oracle_commits ADD COLUMN claimed_until INTEGER;
ALTER TABLE oracle_commits ADD COLUMN next_attempt_at INTEGER;
