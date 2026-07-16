"use strict";

const crypto = require("node:crypto");

function parseJson(value, fallback = null) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    payload: parseJson(row.payload_json, {}),
    created_at: row.created_at,
  };
}

function matches(pattern, type) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

class EventBus {
  constructor({ db } = {}) {
    if (!db) throw new Error("EventBus requires db");
    this.db = db;
    this.handlers = [];
    this.inFlight = new Set();
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
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
    `);
  }

  on(pattern, name, handler) {
    if (!pattern || !name || typeof handler !== "function") throw new Error("pattern, name and handler are required");
    this.handlers.push({ pattern: String(pattern), name: String(name), handler });
    return () => {
      this.handlers = this.handlers.filter((entry) => entry.handler !== handler);
    };
  }

  emit(type, payload = {}, { source = "internal" } = {}) {
    const cleanType = String(type || "").trim().slice(0, 120);
    if (!cleanType) throw new Error("event type is required");
    const event = {
      id: crypto.randomUUID(),
      type: cleanType,
      source: String(source || "internal").slice(0, 120),
      payload: payload && typeof payload === "object" ? payload : { value: payload },
      created_at: Date.now(),
    };
    this.db.prepare(`
      INSERT INTO board_events (id, type, source, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, event.type, event.source, JSON.stringify(event.payload), event.created_at);

    const task = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.dispatch(event))
      .catch((error) => console.error(`[ai-board] event ${event.id} dispatch failed:`, error));
    this.inFlight.add(task);
    task.finally(() => this.inFlight.delete(task));
    return event;
  }

  async dispatch(event) {
    const handlers = this.handlers.filter((entry) => matches(entry.pattern, event.type));
    for (const entry of handlers) {
      let status = "completed";
      let detail = null;
      let errorText = null;
      try {
        detail = await entry.handler(event);
        if (detail && detail.status === "skipped") status = "skipped";
      } catch (error) {
        status = "failed";
        errorText = String(error?.message || error).slice(0, 2000);
      }
      this.db.prepare(`
        INSERT INTO event_receipts (id, event_id, handler, status, detail_json, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        event.id,
        entry.name,
        status,
        detail == null ? null : JSON.stringify(detail),
        errorText,
        Date.now()
      );
    }
    return event;
  }

  async waitForIdle() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  list({ limit = 50, type = null, since = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
    let sql = "SELECT * FROM board_events WHERE 1=1";
    const params = [];
    if (type) {
      sql += " AND type = ?";
      params.push(String(type));
    }
    if (since) {
      sql += " AND created_at > ?";
      params.push(Number(since) || 0);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(safeLimit);
    return this.db.prepare(sql).all(...params).map(serializeEvent);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM board_events WHERE id = ?").get(String(id));
    if (!row) return null;
    const receipts = this.db.prepare("SELECT * FROM event_receipts WHERE event_id = ? ORDER BY created_at ASC").all(row.id)
      .map((receipt) => ({
        handler: receipt.handler,
        status: receipt.status,
        detail: parseJson(receipt.detail_json, null),
        error: receipt.error,
        created_at: receipt.created_at,
      }));
    return { ...serializeEvent(row), receipts };
  }
}

module.exports = { EventBus, matches, serializeEvent };
