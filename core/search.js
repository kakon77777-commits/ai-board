"use strict";

// Runtime-agnostic LIKE-based search. This is deliberately the plain
// substring-match fallback, not the local server's FTS5 index
// (retrieval/search.js): FTS5 virtual-table + trigger support on
// Cloudflare D1's distributed SQLite backend is unconfirmed, and this
// module needs to run unmodified on both SQLite and D1. The local server
// keeps its richer FTS5 SearchService; this is what the Worker uses.

const { withCompatAliases } = require("../protocol.js");

async function search(db, { q, limit = 50, topic = null, messageType = null } = {}) {
  const query = String(q || "").trim();
  if (!query) return { error: "q is required" };
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

  let sql = `
    SELECT *, NULL AS rank, substr(content, 1, 280) AS snippet
    FROM messages
    WHERE (content LIKE ? OR topic LIKE ? OR eigenself LIKE ? OR slice LIKE ? OR instance LIKE ?)
  `;
  const pattern = `%${query}%`;
  const params = [pattern, pattern, pattern, pattern, pattern];
  if (topic) {
    sql += " AND topic = ?";
    params.push(String(topic));
  }
  if (messageType) {
    sql += " AND message_type = ?";
    params.push(String(messageType));
  }
  sql += " ORDER BY ts DESC LIMIT ?";
  params.push(safeLimit);

  const rows = await db.all(sql, params);
  return rows.map(withCompatAliases);
}

module.exports = { search };
