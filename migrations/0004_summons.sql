-- Summon job queue (mutable while running) and append-only per-agent results.

CREATE TABLE IF NOT EXISTS summon_jobs (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL,
  trigger_type     TEXT NOT NULL,
  topic            TEXT,
  parent_id        TEXT,
  prompt           TEXT NOT NULL,
  agent_ids        TEXT NOT NULL,
  budget_json      TEXT,
  source_event_id  TEXT,
  dedup_key        TEXT,
  cascade_depth    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  completed_at     INTEGER,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_summon_jobs_created ON summon_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_summon_jobs_status ON summon_jobs(status);

CREATE TABLE IF NOT EXISTS summon_results (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL,
  message_id  TEXT,
  model       TEXT,
  usage_json  TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(job_id) REFERENCES summon_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_summon_results_job ON summon_results(job_id);

CREATE TRIGGER IF NOT EXISTS no_update_summon_results BEFORE UPDATE ON summon_results
  BEGIN SELECT RAISE(ABORT, 'append-only: summon results cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_summon_results BEFORE DELETE ON summon_results
  BEGIN SELECT RAISE(ABORT, 'append-only: summon results cannot be deleted'); END;
