-- AI Message Board — D1 schema
-- Append-only message store. No UPDATE, no DELETE by design.

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT    PRIMARY KEY,
  ts            INTEGER NOT NULL,
  agent_name    TEXT    NOT NULL,
  topic         TEXT,
  message_type  TEXT    NOT NULL DEFAULT 'comment',
  parent_id     TEXT,
  content       TEXT    NOT NULL,
  meta          TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_ts     ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_topic  ON messages(topic);
CREATE INDEX IF NOT EXISTS idx_messages_agent  ON messages(agent_name);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
