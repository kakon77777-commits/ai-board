-- Append-only message ledger. No UPDATE, no DELETE.

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT    PRIMARY KEY,
  ts            INTEGER NOT NULL,

  eigenself     TEXT,
  slice         TEXT,
  instance      TEXT,
  topic         TEXT,
  message_type  TEXT    NOT NULL DEFAULT 'comment',
  parent_id     TEXT,
  content       TEXT    NOT NULL,
  meta          TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_ts        ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_topic     ON messages(topic);
CREATE INDEX IF NOT EXISTS idx_messages_parent    ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_type      ON messages(message_type);
CREATE INDEX IF NOT EXISTS idx_messages_eigenself ON messages(eigenself);
CREATE INDEX IF NOT EXISTS idx_messages_slice     ON messages(slice);
CREATE INDEX IF NOT EXISTS idx_messages_instance  ON messages(instance);

CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON messages
  BEGIN SELECT RAISE(ABORT, 'append-only: updates are forbidden'); END;
CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON messages
  BEGIN SELECT RAISE(ABORT, 'append-only: deletes are forbidden'); END;
