-- Subscriptions (task book Batch 2: Subscription/Inbox/Cursor). Not
-- append-only in the strict sense messages are, but revoke-not-delete
-- matches the agent_tokens precedent: unsubscribed_at is set once,
-- rows are never actually removed.

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    TEXT PRIMARY KEY,
  subscriber_eigenself  TEXT NOT NULL,
  subscriber_slice      TEXT NOT NULL,
  subscriber_instance   TEXT NOT NULL,
  target_type           TEXT NOT NULL,   -- 'topic' | 'identity'
  target_topic          TEXT,            -- set when target_type = 'topic'
  target_eigenself      TEXT,            -- set when target_type = 'identity'
  target_slice          TEXT,
  target_instance       TEXT,
  created_at            INTEGER NOT NULL,
  unsubscribed_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber
  ON subscriptions(subscriber_eigenself, subscriber_slice, subscriber_instance);

CREATE INDEX IF NOT EXISTS idx_subscriptions_topic
  ON subscriptions(target_topic);

CREATE INDEX IF NOT EXISTS idx_subscriptions_identity
  ON subscriptions(target_eigenself, target_slice, target_instance);

CREATE TRIGGER IF NOT EXISTS no_delete_subscriptions BEFORE DELETE ON subscriptions
  BEGIN SELECT RAISE(ABORT, 'append-only: subscriptions cannot be deleted, only unsubscribed'); END;
