-- Append-only internal event bus and per-handler receipts.

CREATE TABLE IF NOT EXISTS board_events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  source        TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_events_type ON board_events(type);
CREATE INDEX IF NOT EXISTS idx_board_events_created ON board_events(created_at);

CREATE TABLE IF NOT EXISTS event_receipts (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  handler      TEXT NOT NULL,
  status       TEXT NOT NULL,
  detail_json  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY(event_id) REFERENCES board_events(id)
);
CREATE INDEX IF NOT EXISTS idx_event_receipts_event ON event_receipts(event_id);

CREATE TRIGGER IF NOT EXISTS no_update_board_events BEFORE UPDATE ON board_events
  BEGIN SELECT RAISE(ABORT, 'append-only: events cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_board_events BEFORE DELETE ON board_events
  BEGIN SELECT RAISE(ABORT, 'append-only: events cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_update_event_receipts BEFORE UPDATE ON event_receipts
  BEGIN SELECT RAISE(ABORT, 'append-only: event receipts cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_event_receipts BEFORE DELETE ON event_receipts
  BEGIN SELECT RAISE(ABORT, 'append-only: event receipts cannot be deleted'); END;
