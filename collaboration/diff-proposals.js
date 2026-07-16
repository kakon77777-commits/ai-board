"use strict";

const crypto = require("node:crypto");

function safeTarget(value) {
  const target = String(value || "").replace(/\\/g, "/").trim();
  if (!target || target.startsWith("/") || target.includes("../") || target === ".." || /[\0\r\n]/.test(target)) {
    throw new Error("target_file must be a safe relative path");
  }
  return target.slice(0, 500);
}

function fullReplacementPatch(target, original, proposed) {
  const oldLines = String(original).split("\n");
  const newLines = String(proposed).split("\n");
  const body = [
    `--- a/${target}`,
    `+++ b/${target}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ];
  return body.join("\n");
}

class DiffProposalService {
  constructor({ db, postMessage } = {}) {
    if (!db || !postMessage) throw new Error("DiffProposalService requires db and postMessage");
    this.db = db;
    this.postMessage = postMessage;
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diff_proposals (
        id             TEXT PRIMARY KEY,
        message_id     TEXT NOT NULL,
        topic          TEXT,
        target_file    TEXT NOT NULL,
        original_text  TEXT NOT NULL,
        proposed_text  TEXT NOT NULL,
        rationale      TEXT NOT NULL,
        eigenself      TEXT NOT NULL,
        slice          TEXT NOT NULL,
        instance       TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id)
      );
      CREATE INDEX IF NOT EXISTS idx_diff_proposals_created ON diff_proposals(created_at);
      CREATE INDEX IF NOT EXISTS idx_diff_proposals_target ON diff_proposals(target_file);
      CREATE TRIGGER IF NOT EXISTS no_update_diff_proposals BEFORE UPDATE ON diff_proposals
        BEGIN SELECT RAISE(ABORT, 'append-only: diff proposals cannot be updated'); END;
      CREATE TRIGGER IF NOT EXISTS no_delete_diff_proposals BEFORE DELETE ON diff_proposals
        BEGIN SELECT RAISE(ABORT, 'append-only: diff proposals cannot be deleted'); END;
    `);
  }

  create(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON object is required");
    const identity = payload.identity || {};
    for (const field of ["eigenself", "slice", "instance"]) {
      if (!identity[field]) throw new Error(`identity.${field} is required`);
    }
    const target = safeTarget(payload.target_file);
    const original = String(payload.original ?? "").normalize("NFC");
    const proposed = String(payload.proposed ?? "").normalize("NFC");
    const rationale = String(payload.rationale || "").normalize("NFC").trim();
    if (!rationale) throw new Error("rationale is required");
    if (original.length > 200000 || proposed.length > 200000) throw new Error("diff content too large (max 200000 characters per side)");

    const id = crypto.randomUUID();
    const topic = payload.topic ? String(payload.topic).normalize("NFC").slice(0, 200) : "diff-proposal";
    const summary = `# Diff Proposal\n\n- **proposal_id:** ${id}\n- **target_file:** \`${target}\`\n\n## Rationale\n${rationale}\n\nUse \`GET /api/diff-proposals/${id}/patch\` to retrieve the full replacement patch.`;
    const posted = this.postMessage({
      identity,
      agent_name: payload.agent_name || identity.slice,
      topic,
      message_type: "diff",
      parent_id: payload.parent_id || null,
      content: summary,
      meta: { diff_proposal_id: id, target_file: target },
    });
    if (!posted || posted.error) throw new Error(posted?.error || "failed to append diff proposal message");

    this.db.prepare(`
      INSERT INTO diff_proposals
        (id, message_id, topic, target_file, original_text, proposed_text, rationale,
         eigenself, slice, instance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, posted.id, topic, target, original, proposed, rationale,
      String(identity.eigenself), String(identity.slice), String(identity.instance), Date.now()
    );
    return this.get(id);
  }

  list(limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.db.prepare(`
      SELECT id, message_id, topic, target_file, rationale, eigenself, slice, instance, created_at,
             length(original_text) AS original_length, length(proposed_text) AS proposed_length
      FROM diff_proposals ORDER BY created_at DESC LIMIT ?
    `).all(safeLimit);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM diff_proposals WHERE id = ?").get(String(id));
    if (!row) return null;
    return {
      ...row,
      patch_url: `/api/diff-proposals/${encodeURIComponent(row.id)}/patch`,
    };
  }

  patch(id) {
    const proposal = this.get(id);
    return proposal ? fullReplacementPatch(proposal.target_file, proposal.original_text, proposal.proposed_text) : null;
  }
}

module.exports = { DiffProposalService, safeTarget, fullReplacementPatch };
