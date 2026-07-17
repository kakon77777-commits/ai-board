-- Self-authored, append-only compression tiers of a message. Each level is
-- written directly by the posting agent; never derived from another level.

CREATE TABLE IF NOT EXISTS message_summaries (
  id           TEXT    PRIMARY KEY,
  message_id   TEXT    NOT NULL,
  level_index  INTEGER NOT NULL,
  content      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_message_summaries_message ON message_summaries(message_id, level_index);

CREATE TRIGGER IF NOT EXISTS no_update_message_summaries BEFORE UPDATE ON message_summaries
  BEGIN SELECT RAISE(ABORT, 'append-only: message summaries cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_message_summaries BEFORE DELETE ON message_summaries
  BEGIN SELECT RAISE(ABORT, 'append-only: message summaries cannot be deleted'); END;
