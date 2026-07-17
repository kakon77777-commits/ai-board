-- Append-only audit trail for external delivery (GitHub issue/draft PR) attempts.

CREATE TABLE IF NOT EXISTS delivery_records (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  destination   TEXT,
  status        TEXT NOT NULL,
  request_json  TEXT NOT NULL,
  result_json   TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_records_created ON delivery_records(created_at);
CREATE TRIGGER IF NOT EXISTS no_update_delivery_records BEFORE UPDATE ON delivery_records
  BEGIN SELECT RAISE(ABORT, 'append-only: delivery records cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_delivery_records BEFORE DELETE ON delivery_records
  BEGIN SELECT RAISE(ABORT, 'append-only: delivery records cannot be deleted'); END;
