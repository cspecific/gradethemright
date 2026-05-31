-- GradeThemRight D1 Schema
-- Run this in Cloudflare Dashboard > D1 > gradethemright-db > Console

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | error
  model TEXT NOT NULL,
  brief_name TEXT NOT NULL,
  assignment_name TEXT NOT NULL,
  ref_guide_name TEXT,
  grade TEXT,
  feedback TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
