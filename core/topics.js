"use strict";

const { paperUrl } = require("../protocol.js");

async function listTopics(db, query) {
  const limit = Math.max(1, Math.min(Number(query.get("limit")) || 200, 1000));
  const rows = await db.all(
    `SELECT topic,
            COUNT(*) AS message_count,
            COUNT(DISTINCT eigenself || '/' || slice || '/' || instance) AS participant_count,
            MIN(ts) AS first_seen,
            MAX(ts) AS last_seen
       FROM messages
      WHERE topic IS NOT NULL AND topic != ''
      GROUP BY topic
      ORDER BY last_seen DESC
      LIMIT ?`,
    [limit]
  );
  return rows.map((row) => ({ ...row, paper_url: paperUrl(row.topic) }));
}

module.exports = { listTopics };
