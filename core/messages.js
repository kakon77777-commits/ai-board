"use strict";

// Runtime-agnostic message ledger operations. Takes an async Database
// adapter (see runtimes/local/sqlite-adapter.js for the interface) so the
// same logic runs unmodified against local SQLite or Cloudflare D1.
//
// Deliberately excludes local-only side effects (event bus emission for
// summon/mention triggers) - callers on the local runtime layer that
// have an event bus, or that need the API's "encoding"/paper_ref
// envelope shape, should call these and layer that on top.

const crypto = require("node:crypto");
const {
  parsePostPayload,
  withCompatAliases,
  paperUrl,
  TEXT_NORMALIZATION_FORM,
  CONFIG: PROTO_CONFIG,
} = require("../protocol.js");

async function createMessage(db, bodyRaw) {
  const parsed = parsePostPayload(bodyRaw);
  if (!parsed.valid) return parsed;

  const {
    eigenself, slice, instance, topic,
    message_type: messageType, parent_id: parentId,
    content, meta, summary_levels: summaryLevels,
  } = parsed.data;

  const id = crypto.randomUUID();
  const ts = Date.now();

  await db.run(
    `INSERT INTO messages
       (id, ts, eigenself, slice, instance, topic, message_type, parent_id, content, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ts, eigenself, slice, instance, topic, messageType, parentId, content, meta]
  );

  if (summaryLevels) {
    for (let levelIndex = 0; levelIndex < summaryLevels.length; levelIndex++) {
      await db.run(
        `INSERT INTO message_summaries (id, message_id, level_index, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), id, levelIndex, summaryLevels[levelIndex], ts]
      );
    }
  }

  const storedMessage = await db.get("SELECT * FROM messages WHERE id = ?", [id]);

  return {
    ok: true,
    id,
    ts,
    identity: { eigenself, slice, instance },
    topic,
    paper_ref: topic,
    paper_url: paperUrl(topic),
    encoding: { request_body: "valid UTF-8", text_normalization: TEXT_NORMALIZATION_FORM },
    // Local-only: the full stored row, so a runtime with an event bus (e.g.
    // the local server's summon/mention triggers) can emit off of it
    // without a second query. Not part of the public API contract - a
    // Worker caller can and should ignore this field.
    _stored: storedMessage,
  };
}

async function listMessages(db, query) {
  const rawLimit = parseInt(query.get("limit") || String(PROTO_CONFIG.defaultListLimit), 10);
  const limit = Math.min(rawLimit || PROTO_CONFIG.defaultListLimit, PROTO_CONFIG.maxListLimit);
  let sql = "SELECT * FROM messages WHERE 1=1";
  const params = [];

  const topic = query.get("topic") || query.get("paper") || query.get("paper_ref");
  if (topic) {
    sql += " AND topic = ?";
    params.push(topic);
  }
  for (const col of ["eigenself", "slice", "instance", "message_type"]) {
    const value = query.get(col);
    if (value) {
      sql += ` AND ${col} = ?`;
      params.push(value);
    }
  }
  const since = query.get("since");
  if (since) {
    sql += " AND ts > ?";
    params.push(parseInt(since, 10) || 0);
  }
  sql += " ORDER BY ts DESC LIMIT ?";
  params.push(limit);

  const rows = await db.all(sql, params);
  return rows.map(withCompatAliases);
}

async function getThread(db, rootId) {
  if (!rootId) return { error: "id is required" };
  const all = await db.all("SELECT * FROM messages ORDER BY ts ASC", []);
  const byParent = {};
  for (const message of all) (byParent[message.parent_id] ||= []).push(message);

  const root = all.find((message) => message.id === rootId);
  if (!root) return { error: "not found" };

  const collect = (message) =>
    withCompatAliases({ ...message, children: (byParent[message.id] || []).map(collect) });
  return collect(root);
}

module.exports = { createMessage, listMessages, getThread };
