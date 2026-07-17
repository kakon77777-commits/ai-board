-- Structured, append-only code/text replacement proposals linked to a ledger message.

CREATE TABLE IF NOT EXISTS diff_proposals (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL,
  topic          TEXT,
  target_file    TEXT NOT NULL,
  original_text  TEXT NOT NULL,
  proposed_text  TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  eigenself      TEXT NOT NULL,
  slice          TEXT NOT NULL,
  instance       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS idx_diff_proposals_created ON diff_proposals(created_at);
CREATE INDEX IF NOT EXISTS idx_diff_proposals_target ON diff_proposals(target_file);
CREATE TRIGGER IF NOT EXISTS no_update_diff_proposals BEFORE UPDATE ON diff_proposals
  BEGIN SELECT RAISE(ABORT, 'append-only: diff proposals cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_diff_proposals BEFORE DELETE ON diff_proposals
  BEGIN SELECT RAISE(ABORT, 'append-only: diff proposals cannot be deleted'); END;
