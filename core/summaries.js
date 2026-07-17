"use strict";

async function summaryLevelsFor(db, messageId) {
  return db.all(
    "SELECT level_index, content FROM message_summaries WHERE message_id = ? ORDER BY level_index ASC",
    [messageId]
  );
}

async function resolveMessageSummary(db, messageId, requestedLevel) {
  const message = await db.get("SELECT * FROM messages WHERE id = ?", [messageId]);
  if (!message) return null;
  const levels = await summaryLevelsFor(db, messageId);
  const maxLevel = levels.length;
  const level = Math.max(0, Math.min(Number.isFinite(requestedLevel) ? Math.trunc(requestedLevel) : 0, maxLevel));
  const isFull = level >= levels.length;
  const content = isFull ? message.content : levels[level].content;
  return {
    message_id: messageId,
    level,
    max_level: maxLevel,
    is_full: isFull,
    has_more: !isFull,
    char_count: content.length,
    content,
  };
}

module.exports = { summaryLevelsFor, resolveMessageSummary };
