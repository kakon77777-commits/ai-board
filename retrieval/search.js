"use strict";

function quoteFtsQuery(raw) {
  return String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" AND ");
}

class SearchService {
  constructor({ db, withAliases = (row) => row } = {}) {
    if (!db) throw new Error("SearchService requires db");
    this.db = db;
    this.withAliases = withAliases;
    this.ftsEnabled = false;
    this.init();
  }

  init() {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          message_id UNINDEXED,
          topic,
          content,
          eigenself,
          slice,
          instance,
          tokenize = 'unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(message_id, topic, content, eigenself, slice, instance)
          VALUES (new.id, coalesce(new.topic, ''), new.content, coalesce(new.eigenself, ''), coalesce(new.slice, ''), coalesce(new.instance, ''));
        END;
      `);
      this.db.exec("DELETE FROM messages_fts");
      this.db.exec(`
        INSERT INTO messages_fts(message_id, topic, content, eigenself, slice, instance)
        SELECT id, coalesce(topic, ''), content, coalesce(eigenself, ''), coalesce(slice, ''), coalesce(instance, '')
        FROM messages
      `);
      this.ftsEnabled = true;
    } catch (error) {
      this.ftsEnabled = false;
      this.initError = String(error?.message || error);
    }
  }

  status() {
    return { fts5: this.ftsEnabled, error: this.initError || null };
  }

  search({ q, limit = 50, topic = null, messageType = null } = {}) {
    const query = String(q || "").trim();
    if (!query) throw new Error("q is required");
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

    if (this.ftsEnabled) {
      try {
        let sql = `
          SELECT m.*, bm25(messages_fts) AS rank,
                 snippet(messages_fts, 2, '<mark>', '</mark>', ' … ', 24) AS snippet
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.message_id
          WHERE messages_fts MATCH ?
        `;
        const params = [quoteFtsQuery(query)];
        if (topic) { sql += " AND m.topic = ?"; params.push(String(topic)); }
        if (messageType) { sql += " AND m.message_type = ?"; params.push(String(messageType)); }
        sql += " ORDER BY rank ASC, m.ts DESC LIMIT ?";
        params.push(safeLimit);
        return this.db.prepare(sql).all(...params).map((row) => this.withAliases(row));
      } catch {
        // Fall through to literal LIKE search when FTS syntax or runtime support fails.
      }
    }

    let sql = `
      SELECT *, NULL AS rank,
             substr(content, 1, 280) AS snippet
      FROM messages
      WHERE (content LIKE ? OR topic LIKE ? OR eigenself LIKE ? OR slice LIKE ? OR instance LIKE ?)
    `;
    const pattern = `%${query}%`;
    const params = [pattern, pattern, pattern, pattern, pattern];
    if (topic) { sql += " AND topic = ?"; params.push(String(topic)); }
    if (messageType) { sql += " AND message_type = ?"; params.push(String(messageType)); }
    sql += " ORDER BY ts DESC LIMIT ?";
    params.push(safeLimit);
    return this.db.prepare(sql).all(...params).map((row) => this.withAliases(row));
  }
}

module.exports = { SearchService, quoteFtsQuery };
