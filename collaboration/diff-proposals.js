"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
  constructor({ db, postMessage, applyRoot = "" } = {}) {
    if (!db || !postMessage) throw new Error("DiffProposalService requires db and postMessage");
    this.db = db;
    this.postMessage = postMessage;
    this.applyRoot = "";
    if (applyRoot) {
      try {
        this.applyRoot = fs.realpathSync(String(applyRoot));
      } catch (error) {
        console.error(`[ai-board] AIBOARD_APPLY_ROOT is invalid, diff-apply disabled: ${error.message}`);
      }
    }
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

      CREATE TABLE IF NOT EXISTS diff_proposal_applications (
        id            TEXT PRIMARY KEY,
        proposal_id   TEXT NOT NULL,
        target_file   TEXT NOT NULL,
        status        TEXT NOT NULL,
        bytes_written INTEGER,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES diff_proposals(id)
      );
      CREATE INDEX IF NOT EXISTS idx_diff_proposal_applications_proposal ON diff_proposal_applications(proposal_id);
      CREATE TRIGGER IF NOT EXISTS no_update_diff_proposal_applications BEFORE UPDATE ON diff_proposal_applications
        BEGIN SELECT RAISE(ABORT, 'append-only: diff proposal applications cannot be updated'); END;
      CREATE TRIGGER IF NOT EXISTS no_delete_diff_proposal_applications BEFORE DELETE ON diff_proposal_applications
        BEGIN SELECT RAISE(ABORT, 'append-only: diff proposal applications cannot be deleted'); END;
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

  applyStatus() {
    return { enabled: Boolean(this.applyRoot), root: this.applyRoot || null };
  }

  resolveApplyPath(targetFile) {
    if (!this.applyRoot) throw new Error("diff-apply is not configured; set AIBOARD_APPLY_ROOT");
    const target = safeTarget(targetFile);
    const resolved = path.resolve(this.applyRoot, target);
    const rootWithSep = this.applyRoot.endsWith(path.sep) ? this.applyRoot : this.applyRoot + path.sep;
    if (resolved !== this.applyRoot && !resolved.startsWith(rootWithSep)) {
      throw new Error("resolved path escapes the configured apply root");
    }
    return resolved;
  }

  previewApply(id) {
    const proposal = this.get(id);
    if (!proposal) throw new Error("diff proposal not found");
    const resolvedPath = this.resolveApplyPath(proposal.target_file);
    const fileExists = fs.existsSync(resolvedPath);
    const currentContent = fileExists ? fs.readFileSync(resolvedPath, "utf8") : "";
    return {
      proposal_id: proposal.id,
      target_file: proposal.target_file,
      resolved_path: resolvedPath,
      file_exists: fileExists,
      matches_original: currentContent === proposal.original_text,
      would_write_bytes: Buffer.byteLength(proposal.proposed_text, "utf8"),
      patch_url: proposal.patch_url,
    };
  }

  recordApplication(proposalId, targetFile, status, bytesWritten, error) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO diff_proposal_applications (id, proposal_id, target_file, status, bytes_written, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, proposalId, targetFile, status, bytesWritten ?? null, error ? String(error).slice(0, 4000) : null, Date.now());
    return id;
  }

  listApplications(limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.db.prepare("SELECT * FROM diff_proposal_applications ORDER BY created_at DESC LIMIT ?").all(safeLimit);
  }

  applyProposal(id, { execute = false } = {}) {
    const preview = this.previewApply(id);
    if (execute !== true) return { preview: true, ...preview };

    if (!preview.matches_original) {
      const message = "current file content does not match the proposal's original_text; refusing to apply a stale or conflicting diff";
      this.recordApplication(preview.proposal_id, preview.target_file, "failed", null, message);
      throw new Error(message);
    }

    const proposal = this.get(id);
    try {
      fs.mkdirSync(path.dirname(preview.resolved_path), { recursive: true });
      fs.writeFileSync(preview.resolved_path, proposal.proposed_text, "utf8");
      const bytesWritten = Buffer.byteLength(proposal.proposed_text, "utf8");
      this.recordApplication(preview.proposal_id, preview.target_file, "completed", bytesWritten, null);
      return {
        applied: true,
        proposal_id: preview.proposal_id,
        target_file: preview.target_file,
        resolved_path: preview.resolved_path,
        bytes_written: bytesWritten,
      };
    } catch (error) {
      this.recordApplication(preview.proposal_id, preview.target_file, "failed", null, error.message);
      throw error;
    }
  }
}

module.exports = { DiffProposalService, safeTarget, fullReplacementPatch };
