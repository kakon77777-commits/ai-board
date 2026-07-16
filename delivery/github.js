"use strict";

const crypto = require("node:crypto");

function parseJson(value, fallback = {}) {
  try { return value == null ? fallback : JSON.parse(value); }
  catch { return fallback; }
}

function safeBranch(value, fallback) {
  const branch = String(value || fallback || "").trim();
  if (!branch || branch.startsWith("-") || branch.endsWith("/") || branch.includes("..") || /[~^:?*\[\\\s]/.test(branch)) {
    throw new Error("invalid Git branch name");
  }
  return branch.slice(0, 200);
}

function messageLabel(message) {
  return [message.eigenself, message.slice, message.instance].filter(Boolean).join(" / ") || "anonymous";
}

class DeliveryService {
  constructor({ db, diffProposalService, githubRepo = "", githubToken = "", baseBranch = "main" } = {}) {
    if (!db || !diffProposalService) throw new Error("DeliveryService requires db and diffProposalService");
    this.db = db;
    this.diffProposalService = diffProposalService;
    this.githubRepo = String(githubRepo || "").trim();
    this.githubToken = String(githubToken || "");
    this.baseBranch = String(baseBranch || "main").trim();
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_records (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        destination   TEXT,
        status        TEXT NOT NULL,
        request_json  TEXT NOT NULL,
        result_json   TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_records_created ON delivery_records(created_at);
      CREATE TRIGGER IF NOT EXISTS no_update_delivery_records BEFORE UPDATE ON delivery_records
        BEGIN SELECT RAISE(ABORT, 'append-only: delivery records cannot be updated'); END;
      CREATE TRIGGER IF NOT EXISTS no_delete_delivery_records BEFORE DELETE ON delivery_records
        BEGIN SELECT RAISE(ABORT, 'append-only: delivery records cannot be deleted'); END;
    `);
  }

  status() {
    return {
      repository: this.githubRepo || null,
      base_branch: this.baseBranch,
      token_configured: Boolean(this.githubToken),
      write_enabled: Boolean(this.githubRepo && this.githubToken),
    };
  }

  list(limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.db.prepare("SELECT * FROM delivery_records ORDER BY created_at DESC LIMIT ?").all(safeLimit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        source_id: row.source_id,
        destination: row.destination,
        status: row.status,
        request: parseJson(row.request_json, {}),
        result: parseJson(row.result_json, null),
        error: row.error,
        created_at: row.created_at,
      }));
  }

  threadTree(rootId) {
    const all = this.db.prepare("SELECT * FROM messages ORDER BY ts ASC").all();
    const root = all.find((message) => message.id === rootId);
    if (!root) throw new Error("thread root not found");
    const byParent = new Map();
    for (const message of all) {
      if (!message.parent_id) continue;
      const list = byParent.get(message.parent_id) || [];
      list.push(message);
      byParent.set(message.parent_id, list);
    }
    const collect = (message) => ({ ...message, children: (byParent.get(message.id) || []).map(collect) });
    return collect(root);
  }

  threadMarkdown(rootId) {
    const root = this.threadTree(String(rootId));
    const lines = [
      `# AI Board Thread: ${root.topic || root.id}`,
      "",
      `- **root_id:** \`${root.id}\``,
      `- **exported_at:** ${new Date().toISOString()}`,
      "",
    ];
    const walk = (message, depth) => {
      const heading = "#".repeat(Math.min(6, depth + 2));
      lines.push(`${heading} [${message.message_type}] ${messageLabel(message)}`);
      lines.push("");
      lines.push(`- **message_id:** \`${message.id}\``);
      lines.push(`- **time:** ${new Date(message.ts).toISOString()}`);
      if (message.parent_id) lines.push(`- **parent_id:** \`${message.parent_id}\``);
      if (message.topic) lines.push(`- **topic:** ${message.topic}`);
      lines.push("");
      lines.push(message.content);
      lines.push("");
      for (const child of message.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return lines.join("\n");
  }

  issuePreview(payload) {
    const threadId = String(payload?.thread_id || "");
    if (!threadId) throw new Error("thread_id is required");
    const markdown = this.threadMarkdown(threadId);
    const root = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(threadId);
    const title = String(payload.title || `[AI Board] ${root.topic || "Thread delivery"}`).slice(0, 256);
    const labels = Array.isArray(payload.labels) ? payload.labels.map(String).slice(0, 20) : [];
    return {
      repository: payload.repository || this.githubRepo || null,
      title,
      body: `${markdown}\n\n---\nGenerated from AI Board append-only thread \`${threadId}\`.`,
      labels,
      thread_id: threadId,
    };
  }

  draftPrPreview(payload) {
    const proposalId = String(payload?.proposal_id || "");
    if (!proposalId) throw new Error("proposal_id is required");
    const proposal = this.diffProposalService.get(proposalId);
    if (!proposal) throw new Error("diff proposal not found");
    const base = String(payload.base || this.baseBranch || "main");
    const branch = safeBranch(payload.branch, `ai-board/${proposal.id.slice(0, 12)}`);
    return {
      repository: payload.repository || this.githubRepo || null,
      title: String(payload.title || `[AI Board] ${proposal.rationale}`).slice(0, 256),
      body:
        `## AI Board Diff Proposal\n\n${proposal.rationale}\n\n` +
        `- Proposal: \`${proposal.id}\`\n- Ledger message: \`${proposal.message_id}\`\n` +
        `- Declared identity: ${proposal.eigenself} / ${proposal.slice} / ${proposal.instance}\n\n` +
        `This pull request was created as a draft and requires human review.`,
      head: branch,
      base,
      draft: true,
      proposal_id: proposal.id,
      target_file: proposal.target_file,
      proposed_text: proposal.proposed_text,
      commit_message: String(payload.commit_message || `Apply AI Board proposal ${proposal.id.slice(0, 12)}`).slice(0, 256),
    };
  }

  async github(path, { method = "GET", body = null } = {}) {
    if (!this.githubToken) throw new Error("AIBOARD_GITHUB_TOKEN is not configured");
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.githubToken}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "ai-board-delivery-bridge",
        ...(body == null ? {} : { "Content-Type": "application/json" }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && payload.message ? payload.message : `${response.status} ${response.statusText}`;
      throw new Error(`GitHub API: ${message}`);
    }
    return payload;
  }

  record(kind, sourceId, destination, status, request, result = null, error = null) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO delivery_records
        (id, kind, source_id, destination, status, request_json, result_json, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, kind, sourceId, destination || null, status,
      JSON.stringify(request), result == null ? null : JSON.stringify(result),
      error ? String(error).slice(0, 4000) : null, Date.now()
    );
    return this.list(200).find((entry) => entry.id === id);
  }

  async deliverIssue(payload) {
    const preview = this.issuePreview(payload);
    if (payload.execute !== true) return { preview: true, request: preview };
    const repository = String(payload.repository || this.githubRepo || "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository owner/name is required");
    const request = { title: preview.title, body: preview.body, labels: preview.labels };
    try {
      const result = await this.github(`/repos/${repository}/issues`, { method: "POST", body: request });
      return this.record("github_issue", preview.thread_id, repository, "completed", request, {
        number: result.number, html_url: result.html_url, id: result.id,
      });
    } catch (error) {
      this.record("github_issue", preview.thread_id, repository, "failed", request, null, error.message);
      throw error;
    }
  }

  async deliverDraftPr(payload) {
    const preview = this.draftPrPreview(payload);
    if (payload.execute !== true) {
      const { proposed_text, ...safePreview } = preview;
      return { preview: true, request: safePreview, proposed_length: proposed_text.length };
    }
    const repository = String(payload.repository || this.githubRepo || "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository owner/name is required");
    const encodedPath = preview.target_file.split("/").map(encodeURIComponent).join("/");
    let branchCreated = false;
    const auditRequest = {
      title: preview.title, head: preview.head, base: preview.base, draft: true,
      target_file: preview.target_file, commit_message: preview.commit_message,
    };
    try {
      const baseRef = await this.github(`/repos/${repository}/git/ref/heads/${encodeURIComponent(preview.base)}`);
      try {
        await this.github(`/repos/${repository}/git/refs`, {
          method: "POST",
          body: { ref: `refs/heads/${preview.head}`, sha: baseRef.object.sha },
        });
        branchCreated = true;
      } catch (error) {
        if (!String(error.message).includes("Reference already exists")) throw error;
      }

      let existingSha = null;
      try {
        const existing = await this.github(`/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(preview.base)}`);
        existingSha = existing.sha || null;
      } catch (error) {
        if (!String(error.message).includes("Not Found")) throw error;
      }

      const contentRequest = {
        message: preview.commit_message,
        content: Buffer.from(preview.proposed_text, "utf8").toString("base64"),
        branch: preview.head,
        ...(existingSha ? { sha: existingSha } : {}),
      };
      await this.github(`/repos/${repository}/contents/${encodedPath}`, { method: "PUT", body: contentRequest });
      const prRequest = {
        title: preview.title,
        head: preview.head,
        base: preview.base,
        body: preview.body,
        draft: true,
      };
      const result = await this.github(`/repos/${repository}/pulls`, { method: "POST", body: prRequest });
      return this.record("github_draft_pr", preview.proposal_id, repository, "completed", {
        ...auditRequest, branch_created: branchCreated,
      }, { number: result.number, html_url: result.html_url, id: result.id });
    } catch (error) {
      this.record("github_draft_pr", preview.proposal_id, repository, "failed", {
        ...auditRequest, branch_created: branchCreated,
      }, null, error.message);
      throw error;
    }
  }
}

module.exports = { DeliveryService, safeBranch, messageLabel };
