"use strict";

const crypto = require("node:crypto");

function parseJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function ensureColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function serializeJob(row, results = []) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    trigger_type: row.trigger_type,
    topic: row.topic,
    parent_id: row.parent_id,
    prompt: row.prompt,
    agent_ids: parseJson(row.agent_ids, []),
    budget: parseJson(row.budget_json, {}),
    source_event_id: row.source_event_id || null,
    dedup_key: row.dedup_key || null,
    cascade_depth: Number(row.cascade_depth || 0),
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error: row.error,
    results: results.map((result) => ({
      agent_id: result.agent_id,
      status: result.status,
      message_id: result.message_id,
      model: result.model,
      usage: parseJson(result.usage_json, null),
      error: result.error,
      created_at: result.created_at,
    })),
  };
}

class SummonService {
  constructor({
    db,
    registry,
    postMessage,
    emitEvent = null,
    maxPromptLength = 20000,
    maxAgentsPerJob = 8,
    maxCascadeDepth = 2,
    maxPendingJobs = 100,
    defaultCooldownMs = 300000,
  }) {
    this.db = db;
    this.registry = registry;
    this.postMessage = postMessage;
    this.emitEvent = emitEvent;
    this.maxPromptLength = maxPromptLength;
    this.maxAgentsPerJob = maxAgentsPerJob;
    this.maxCascadeDepth = Math.max(0, Number(maxCascadeDepth) || 0);
    this.maxPendingJobs = Math.max(1, Number(maxPendingJobs) || 100);
    this.defaultCooldownMs = Math.max(1000, Number(defaultCooldownMs) || 300000);
    this.running = new Set();
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summon_jobs (
        id               TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        trigger_type     TEXT NOT NULL,
        topic            TEXT,
        parent_id        TEXT,
        prompt           TEXT NOT NULL,
        agent_ids        TEXT NOT NULL,
        budget_json      TEXT,
        source_event_id  TEXT,
        dedup_key        TEXT,
        cascade_depth    INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        started_at       INTEGER,
        completed_at     INTEGER,
        error            TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_summon_jobs_created ON summon_jobs(created_at);
      CREATE INDEX IF NOT EXISTS idx_summon_jobs_status ON summon_jobs(status);

      CREATE TABLE IF NOT EXISTS summon_results (
        id          TEXT PRIMARY KEY,
        job_id      TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        status      TEXT NOT NULL,
        message_id  TEXT,
        model       TEXT,
        usage_json  TEXT,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY(job_id) REFERENCES summon_jobs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_summon_results_job ON summon_results(job_id);

      CREATE TRIGGER IF NOT EXISTS no_update_summon_results BEFORE UPDATE ON summon_results
        BEGIN SELECT RAISE(ABORT, 'append-only: summon results cannot be updated'); END;
      CREATE TRIGGER IF NOT EXISTS no_delete_summon_results BEFORE DELETE ON summon_results
        BEGIN SELECT RAISE(ABORT, 'append-only: summon results cannot be deleted'); END;
    `);

    ensureColumn(this.db, "summon_jobs", "source_event_id", "TEXT");
    ensureColumn(this.db, "summon_jobs", "dedup_key", "TEXT");
    ensureColumn(this.db, "summon_jobs", "cascade_depth", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_summon_jobs_dedup ON summon_jobs(dedup_key, created_at)");
  }

  validatePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON object is required");
    const prompt = String(payload.prompt || "").normalize("NFC").trim();
    if (!prompt) throw new Error("prompt is required");
    if (prompt.length > this.maxPromptLength) throw new Error(`prompt too long (max ${this.maxPromptLength})`);

    const agentIds = Array.isArray(payload.agent_ids)
      ? [...new Set(payload.agent_ids.map((value) => String(value).trim()).filter(Boolean))]
      : payload.agent_id
        ? [String(payload.agent_id).trim()]
        : [];
    if (!agentIds.length) throw new Error("agent_id or agent_ids is required");
    if (agentIds.length > this.maxAgentsPerJob) throw new Error(`too many agents (max ${this.maxAgentsPerJob})`);
    for (const id of agentIds) this.registry.get(id);

    const topic = payload.topic ? String(payload.topic).normalize("NFC").slice(0, 200) : null;
    const parentId = payload.parent_id ? String(payload.parent_id).normalize("NFC").slice(0, 200) : null;
    if (parentId && !this.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(parentId)) {
      throw new Error("parent_id not found");
    }

    return {
      prompt,
      agentIds,
      topic,
      parentId,
      triggerType: String(payload.trigger_type || "manual").slice(0, 50),
      budget: payload.budget && typeof payload.budget === "object" ? payload.budget : {},
    };
  }

  create(payload, options = {}) {
    const data = this.validatePayload(payload);
    const cascadeDepth = Math.max(0, Number(options.cascadeDepth ?? payload.cascade_depth ?? 0) || 0);
    if (cascadeDepth > this.maxCascadeDepth) {
      throw new Error(`cascade depth exceeds limit (${this.maxCascadeDepth})`);
    }

    const dedupKey = options.dedupKey ? String(options.dedupKey).slice(0, 500) : null;
    const sourceEventId = options.sourceEventId ? String(options.sourceEventId).slice(0, 200) : null;
    const cooldownMs = Math.max(1000, Number(options.cooldownMs) || this.defaultCooldownMs);
    if (dedupKey) {
      const duplicate = this.db.prepare(`
        SELECT * FROM summon_jobs
        WHERE dedup_key = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(dedupKey, Date.now() - cooldownMs);
      if (duplicate) {
        return { ...serializeJob(duplicate, this.resultsFor(duplicate.id)), deduplicated: true };
      }
    }

    const queued = this.db.prepare("SELECT COUNT(*) AS count FROM summon_jobs WHERE status IN ('pending', 'running')").get().count;
    if (queued >= this.maxPendingJobs) throw new Error(`summon queue is full (max ${this.maxPendingJobs})`);

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO summon_jobs
        (id, status, trigger_type, topic, parent_id, prompt, agent_ids, budget_json,
         source_event_id, dedup_key, cascade_depth, created_at)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.triggerType,
      data.topic,
      data.parentId,
      data.prompt,
      JSON.stringify(data.agentIds),
      JSON.stringify(data.budget),
      sourceEventId,
      dedupKey,
      cascadeDepth,
      createdAt
    );

    this.emitEvent?.("summon.created", {
      job_id: id,
      trigger_type: data.triggerType,
      source_event_id: sourceEventId,
      cascade_depth: cascadeDepth,
      agent_ids: data.agentIds,
      topic: data.topic,
      parent_id: data.parentId,
    }, { source: "summon-service" });

    setImmediate(() => this.run(id).catch((error) => {
      console.error(`[ai-board] summon job ${id} failed:`, error);
    }));
    return this.get(id);
  }

  list(limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.db.prepare("SELECT * FROM summon_jobs ORDER BY created_at DESC LIMIT ?").all(safeLimit)
      .map((row) => serializeJob(row, this.resultsFor(row.id)));
  }

  resultsFor(jobId) {
    return this.db.prepare("SELECT * FROM summon_results WHERE job_id = ? ORDER BY created_at ASC").all(jobId);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM summon_jobs WHERE id = ?").get(id);
    return serializeJob(row, row ? this.resultsFor(row.id) : []);
  }

  buildContext(job) {
    const messages = [];
    const seen = new Set();
    const add = (row) => {
      if (row && !seen.has(row.id)) {
        seen.add(row.id);
        messages.push(row);
      }
    };

    if (job.parent_id) {
      let current = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(job.parent_id);
      const ancestry = [];
      let depth = 0;
      while (current && depth < 12) {
        ancestry.unshift(current);
        current = current.parent_id
          ? this.db.prepare("SELECT * FROM messages WHERE id = ?").get(current.parent_id)
          : null;
        depth += 1;
      }
      ancestry.forEach(add);
    }

    const topic = job.topic || (job.parent_id
      ? this.db.prepare("SELECT topic FROM messages WHERE id = ?").get(job.parent_id)?.topic
      : null);
    if (topic) {
      const recent = this.db.prepare("SELECT * FROM messages WHERE topic = ? ORDER BY ts DESC LIMIT 20").all(topic).reverse();
      recent.forEach(add);
    }

    if (!messages.length) {
      this.db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT 12").all().reverse().forEach(add);
    }
    return messages.slice(-24);
  }

  async run(id) {
    if (this.running.has(id)) return this.get(id);
    const job = this.db.prepare("SELECT * FROM summon_jobs WHERE id = ?").get(id);
    if (!job || job.status !== "pending") return this.get(id);

    this.running.add(id);
    this.db.prepare("UPDATE summon_jobs SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), id);

    const agentIds = parseJson(job.agent_ids, []);
    const context = this.buildContext(job);
    let successes = 0;
    const errors = [];

    try {
      for (const agentId of agentIds) {
        const resultId = crypto.randomUUID();
        try {
          const agent = this.registry.get(agentId);
          const adapter = this.registry.createAdapter(agentId);
          const invocation = await adapter.invoke({
            prompt: job.prompt,
            context,
            topic: job.topic,
            parent_id: job.parent_id,
            max_output_tokens: parseJson(job.budget_json, {}).max_output_tokens,
            system_prompt:
              "You are an invited participant in AI Board, an append-only discussion ledger. " +
              "State uncertainty clearly. Do not claim verified identity beyond your supplied identity tuple. " +
              "Reply to the requested topic and do not issue external side effects.",
          });

          const posted = this.postMessage({
            identity: agent.identity,
            agent_name: agent.display_name,
            topic: job.topic,
            message_type: job.parent_id ? "reply" : "comment",
            parent_id: job.parent_id,
            content: invocation.content,
            meta: {
              summon_job_id: id,
              trigger_type: job.trigger_type,
              source_event_id: job.source_event_id || null,
              summon_cascade_depth: Number(job.cascade_depth || 0),
              adapter: agent.adapter,
              model: invocation.model || agent.model || null,
              usage: invocation.usage || null,
              finish_reason: invocation.finish_reason || null,
              provider_request_id: invocation.provider_request_id || null,
            },
          });
          if (!posted || posted.error) throw new Error(posted?.error || "failed to append agent response");

          this.db.prepare(`
            INSERT INTO summon_results
              (id, job_id, agent_id, status, message_id, model, usage_json, created_at)
            VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)
          `).run(
            resultId,
            id,
            agentId,
            posted.id,
            invocation.model || agent.model || null,
            invocation.usage ? JSON.stringify(invocation.usage) : null,
            Date.now()
          );
          successes += 1;
        } catch (error) {
          const message = String(error?.message || error).slice(0, 2000);
          errors.push(`${agentId}: ${message}`);
          this.db.prepare(`
            INSERT INTO summon_results
              (id, job_id, agent_id, status, error, created_at)
            VALUES (?, ?, ?, 'failed', ?, ?)
          `).run(resultId, id, agentId, message, Date.now());
        }
      }

      const status = successes === agentIds.length ? "completed" : successes > 0 ? "partial" : "failed";
      this.db.prepare("UPDATE summon_jobs SET status = ?, completed_at = ?, error = ? WHERE id = ?")
        .run(status, Date.now(), errors.length ? errors.join("\n") : null, id);

      this.emitEvent?.("summon.completed", {
        job_id: id,
        status,
        successes,
        failures: errors.length,
        source_event_id: job.source_event_id || null,
        cascade_depth: Number(job.cascade_depth || 0),
      }, { source: "summon-service" });
    } finally {
      this.running.delete(id);
    }
    return this.get(id);
  }
}

module.exports = { SummonService, serializeJob, ensureColumn };
