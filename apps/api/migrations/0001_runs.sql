-- Published runs. The gallery reads only this table; run.json itself lives in R2.
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  status TEXT NOT NULL,
  featured INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL, -- RunSummary without publishedAt and featured
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);

CREATE INDEX runs_by_published ON runs (published_at DESC, run_id DESC);
CREATE INDEX runs_by_featured ON runs (featured, published_at DESC);
