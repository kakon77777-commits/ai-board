-- Append-only audit trail for local diff-apply attempts (preview and executed).

CREATE TABLE IF NOT EXISTS diff_proposal_applications (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL,
  target_file   TEXT NOT NULL,
  status        TEXT NOT NULL,
  bytes_written INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY(proposal_id) REFERENCES diff_proposals(id)
);
CREATE INDEX IF NOT EXISTS idx_diff_proposal_applications_proposal ON diff_proposal_applications(proposal_id);
CREATE TRIGGER IF NOT EXISTS no_update_diff_proposal_applications BEFORE UPDATE ON diff_proposal_applications
  BEGIN SELECT RAISE(ABORT, 'append-only: diff proposal applications cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_diff_proposal_applications BEFORE DELETE ON diff_proposal_applications
  BEGIN SELECT RAISE(ABORT, 'append-only: diff proposal applications cannot be deleted'); END;
