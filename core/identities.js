"use strict";

async function listIdentities(db) {
  const rows = await db.all(
    `SELECT eigenself, slice, instance,
            COUNT(*) AS posts, MIN(ts) AS first_seen, MAX(ts) AS last_seen
       FROM messages
      WHERE instance IS NOT NULL OR slice IS NOT NULL OR eigenself IS NOT NULL
      GROUP BY eigenself, slice, instance
      ORDER BY last_seen DESC`,
    []
  );

  const contested = await db.all(
    `SELECT m.instance AS instance, COUNT(*) AS objections
       FROM messages o
       JOIN messages m ON o.parent_id = m.id
      WHERE o.message_type IN ('objection', 'correction') AND m.instance IS NOT NULL
      GROUP BY m.instance`,
    []
  );

  const byInstance = Object.fromEntries(contested.map((row) => [row.instance, row.objections]));
  return rows.map((row) => ({ ...row, objections: byInstance[row.instance] || 0 }));
}

module.exports = { listIdentities };
