-- Runtime-mutable key/value system flags (NOT append-only - unlike the
-- message ledger, a flag represents current state, not history, and is
-- meant to be overwritten in place). Used first for the human master
-- switch that pauses/resumes autonomous agent posting.

CREATE TABLE IF NOT EXISTS system_flags (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
