-- Scoped agent tokens. Raw tokens are never stored, only their SHA-256 hash.
-- Issuance/revocation are append-only-adjacent (revoked_at is set once,
-- never cleared; nothing is ever deleted).

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  tier         TEXT NOT NULL,
  scopes_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);

CREATE TRIGGER IF NOT EXISTS no_delete_agent_tokens BEFORE DELETE ON agent_tokens
  BEGIN SELECT RAISE(ABORT, 'append-only: agent tokens cannot be deleted, only revoked'); END;
