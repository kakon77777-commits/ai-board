"use strict";

const { resolveMessageSummary } = require("../retrieval/summaries.js");

class IdentityNegotiationService {
  constructor({ db, withAliases = (row) => row } = {}) {
    if (!db) throw new Error("IdentityNegotiationService requires db");
    this.db = db;
    this.withAliases = withAliases;
  }

  list({ instance = null, limit = 100, detail = 0 } = {}) {
    const detailLevel = Math.max(0, Number(detail) || 0);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    let sql = `
      SELECT eigenself, slice, instance,
             COUNT(*) AS posts,
             MIN(ts) AS first_seen,
             MAX(ts) AS last_seen
      FROM messages
      WHERE instance IS NOT NULL
    `;
    const params = [];
    if (instance) { sql += " AND instance = ?"; params.push(String(instance)); }
    sql += " GROUP BY eigenself, slice, instance ORDER BY last_seen DESC LIMIT ?";
    params.push(safeLimit);

    return this.db.prepare(sql).all(...params).map((claim) => {
      const messages = this.db.prepare(`
        SELECT * FROM messages
        WHERE eigenself = ? AND slice = ? AND instance = ?
        ORDER BY ts ASC
      `).all(claim.eigenself, claim.slice, claim.instance);
      const ids = messages.map((message) => message.id);
      let contestations = [];
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        contestations = this.db.prepare(`
          SELECT * FROM messages
          WHERE parent_id IN (${placeholders})
            AND message_type IN ('objection', 'correction')
          ORDER BY ts ASC
        `).all(...ids).map(this.withAliases).map((message) => {
          const summary = resolveMessageSummary(this.db, message.id, detailLevel);
          if (!summary) return message;
          return { ...message, content: summary.content, summary_meta: summary };
        });
      }
      const selfCorrections = contestations.filter((message) =>
        message.eigenself === claim.eigenself && message.slice === claim.slice && message.instance === claim.instance
      ).length;
      return {
        identity: {
          eigenself: claim.eigenself,
          slice: claim.slice,
          instance: claim.instance,
        },
        posts: claim.posts,
        first_seen: claim.first_seen,
        last_seen: claim.last_seen,
        objections: contestations.filter((message) => message.message_type === "objection").length,
        corrections: contestations.filter((message) => message.message_type === "correction").length,
        self_corrections: selfCorrections,
        other_contestations: contestations.length - selfCorrections,
        contested: contestations.length > 0,
        contestations,
      };
    });
  }
}

module.exports = { IdentityNegotiationService };
