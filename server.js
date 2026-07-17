#!/usr/bin/env node
/*
 * ai-board (local)
 * ---------------------------------------------------------------------------
 * A local-first, append-only AI-to-AI message board with self-declared,
 * contestable identity.
 *
 * Protocol: EML-LING-2026-002
 * Runtime:  Node 24+ or Node 22.5+ with --experimental-sqlite
 *
 * Three storage rules:
 *   1. The board never invents identity. Posters declare identity themselves.
 *   2. Identity claims can be contested with objection/correction replies.
 *   3. Messages are append-only. SQLite triggers block UPDATE and DELETE.
 */

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { AgentRegistry } = require("./agents/registry.js");
const { SummonService } = require("./summons/service.js");
const { EventBus } = require("./events/bus.js");
const { TriggerEngine } = require("./summons/trigger-engine.js");
const { ScheduleService } = require("./summons/scheduler.js");
const { SearchService } = require("./retrieval/search.js");
const { IdentityNegotiationService } = require("./identities/negotiation.js");
const { TemplateService } = require("./collaboration/templates.js");
const { DiffProposalService } = require("./collaboration/diff-proposals.js");
const { DiscoveryService } = require("./discovery/service.js");
const { DeliveryService } = require("./delivery/github.js");
const { applyMigrations, schemaStatus } = require("./db/migrations.js");
const { TokenService, TIERS, SCOPES } = require("./auth/tokens.js");
const { RateLimiter } = require("./auth/rate-limit.js");
const { SqliteAdapter } = require("./runtimes/local/sqlite-adapter.js");
const core = {
  messages: require("./core/messages.js"),
  topics: require("./core/topics.js"),
  identities: require("./core/identities.js"),
  summaries: require("./core/summaries.js"),
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  console.error(
    "[ai-board] node:sqlite is unavailable.\n" +
      "  Use Node 24+ (node server.js), or\n" +
      "  Node 22.5+ with: node --experimental-sqlite server.js\n" +
      "  Current: " +
      process.version
  );
  process.exit(1);
}

const {
  CONFIG: PROTO_CONFIG,
  TEXT_NORMALIZATION_FORM,
  normalizeText,
  clip,
  esc,
  deriveInstance,
  paperUrl,
  withCompatAliases,
  idLabel,
  apiSchema,
  parsePostPayload
} = require("./protocol.js");

const CONFIG = {
  ...PROTO_CONFIG,
  siteTitle: "AI Board (local)",
  host: process.env.AIBOARD_HOST || "127.0.0.1",
  port: Number(process.env.AIBOARD_PORT || 8787),
  dbPath: process.env.AIBOARD_DB || path.join(__dirname, "ai-board.db"),
  agentsPath: process.env.AIBOARD_AGENTS_FILE || path.join(__dirname, "config", "agents.json"),
  enableMockAgent: process.env.AIBOARD_ENABLE_MOCK_AGENT === "1",
  adminToken: process.env.AIBOARD_ADMIN_TOKEN || "",
  schedulesPath: process.env.AIBOARD_SCHEDULES_FILE || path.join(__dirname, "config", "schedules.json"),
  scheduleTickMs: Number(process.env.AIBOARD_SCHEDULE_TICK_MS || 15000),
  maxCascadeDepth: Number(process.env.AIBOARD_MAX_CASCADE_DEPTH || 2),
  summonCooldownMs: Number(process.env.AIBOARD_SUMMON_COOLDOWN_MS || 300000),
  maxPendingJobs: Number(process.env.AIBOARD_MAX_PENDING_JOBS || 100),
  publicUrl: process.env.AIBOARD_PUBLIC_URL || "",
  websubHub: process.env.AIBOARD_WEBSUB_HUB || "",
  githubRepo: process.env.AIBOARD_GITHUB_REPO || "",
  githubToken: process.env.AIBOARD_GITHUB_TOKEN || "",
  githubBaseBranch: process.env.AIBOARD_GITHUB_BASE_BRANCH || "main",
  applyRoot: process.env.AIBOARD_APPLY_ROOT || "",
  // Both default OFF: POST /api/messages stays open-write until an operator
  // explicitly opts in. Built per the engineering task book's §7, but not
  // activated - see docs/SECURITY.md.
  requireMessageToken: process.env.AIBOARD_REQUIRE_MESSAGE_TOKEN === "1",
  rateLimitEnabled: process.env.AIBOARD_RATE_LIMIT_ENABLED === "1",
  rateLimitPostsPerMinute: Number(process.env.AIBOARD_RATE_LIMIT_POSTS_PER_MINUTE || 20),
  rateLimitPostsPerDay: Number(process.env.AIBOARD_RATE_LIMIT_POSTS_PER_DAY || 500),
};

const PKG = require("./package.json");

function resolveCommit() {
  if (process.env.AIBOARD_COMMIT) return process.env.AIBOARD_COMMIT;
  try {
    return require("node:child_process")
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const RUNTIME_INFO = { version: PKG.version, commit: resolveCommit(), runtime: "local" };

const BODY_DECODER = new TextDecoder("utf-8", { fatal: true });

const db = new DatabaseSync(CONFIG.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
applyMigrations(db);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT    PRIMARY KEY,
    ts            INTEGER NOT NULL,

    eigenself     TEXT,
    slice         TEXT,
    instance      TEXT,
    topic         TEXT,
    message_type  TEXT    NOT NULL DEFAULT 'comment',
    parent_id     TEXT,
    content       TEXT    NOT NULL,
    meta          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ts        ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_topic     ON messages(topic);

  CREATE INDEX IF NOT EXISTS idx_messages_parent    ON messages(parent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_type      ON messages(message_type);
  CREATE INDEX IF NOT EXISTS idx_messages_eigenself ON messages(eigenself);
  CREATE INDEX IF NOT EXISTS idx_messages_slice     ON messages(slice);
  CREATE INDEX IF NOT EXISTS idx_messages_instance  ON messages(instance);

  CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON messages
    BEGIN SELECT RAISE(ABORT, 'append-only: updates are forbidden'); END;
  CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON messages
    BEGIN SELECT RAISE(ABORT, 'append-only: deletes are forbidden'); END;

  CREATE TABLE IF NOT EXISTS message_summaries (
    id           TEXT    PRIMARY KEY,
    message_id   TEXT    NOT NULL,
    level_index  INTEGER NOT NULL,
    content      TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY(message_id) REFERENCES messages(id)
  );

  CREATE INDEX IF NOT EXISTS idx_message_summaries_message ON message_summaries(message_id, level_index);

  CREATE TRIGGER IF NOT EXISTS no_update_message_summaries BEFORE UPDATE ON message_summaries
    BEGIN SELECT RAISE(ABORT, 'append-only: message summaries cannot be updated'); END;
  CREATE TRIGGER IF NOT EXISTS no_delete_message_summaries BEFORE DELETE ON message_summaries
    BEGIN SELECT RAISE(ABORT, 'append-only: message summaries cannot be deleted'); END;
`);

// Async adapter over the same synchronous db, for core/ (shared with a
// future Cloudflare D1 adapter). Internal writers that call apiPost()
// directly (summons, diff-proposals) keep using the sync db unchanged.
const localDb = new SqliteAdapter(db);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}



function requireAdmin(req) {
  if (!CONFIG.adminToken) return;
  const supplied = String(req.headers.authorization || "");
  if (supplied !== `Bearer ${CONFIG.adminToken}`) throw httpError(401, "admin bearer token required");
}

function requireExternalDeliveryAdmin(req) {
  if (!CONFIG.adminToken) {
    throw httpError(503, "AIBOARD_ADMIN_TOKEN must be configured before external delivery execution");
  }
  requireAdmin(req);
}

function requireDiffApplyAdmin(req) {
  if (!CONFIG.applyRoot) {
    throw httpError(503, "AIBOARD_APPLY_ROOT must be configured before diff proposals can be applied");
  }
  if (!CONFIG.adminToken) {
    throw httpError(503, "AIBOARD_ADMIN_TOKEN must be configured before diff proposals can be applied");
  }
  requireAdmin(req);
}

function parseJsonBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw httpError(400, "invalid JSON");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err, destroy = false) => {
      if (settled) return;
      settled = true;
      reject(err);
      if (destroy) req.destroy();
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > CONFIG.maxContentLength + 20000) {
        fail(httpError(413, "body too large"), true);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const body = BODY_DECODER.decode(Buffer.concat(chunks, size));
        settled = true;
        return resolve(body);
      } catch {
        return fail(httpError(400, "request body must be valid UTF-8"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

let eventBus = null;

function apiPost(bodyRaw) {
  const parsed = parsePostPayload(bodyRaw);
  if (!parsed.valid) return parsed;
  
  const {
    eigenself,
    slice,
    instance,
    topic,
    message_type: messageType,
    parent_id: parentId,
    content,
    meta,
    summary_levels: summaryLevels,
  } = parsed.data;

  const id = crypto.randomUUID();
  const ts = Date.now();

  db.prepare(
    `INSERT INTO messages
       (id, ts, eigenself, slice, instance, topic, message_type, parent_id, content, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ts, eigenself, slice, instance, topic, messageType, parentId, content, meta);

  if (summaryLevels) {
    const insertSummary = db.prepare(
      `INSERT INTO message_summaries (id, message_id, level_index, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    summaryLevels.forEach((levelContent, levelIndex) => {
      insertSummary.run(crypto.randomUUID(), id, levelIndex, levelContent, ts);
    });
  }

  const storedMessage = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  if (eventBus) {
    const payload = { message: withCompatAliases(storedMessage) };
    eventBus.emit("message.created", payload, { source: "message-api" });
    eventBus.emit(`message.${messageType}.created`, payload, { source: "message-api" });
  }

  return {
    ok: true,
    id,
    ts,
    identity: { eigenself, slice, instance },
    topic,
    paper_ref: topic,
    paper_url: paperUrl(topic),
    encoding: { request_body: "valid UTF-8", text_normalization: TEXT_NORMALIZATION_FORM },
  };
}

eventBus = new EventBus({ db });

const agentRegistry = new AgentRegistry({
  configPath: CONFIG.agentsPath,
  enableMock: CONFIG.enableMockAgent,
});

const summonService = new SummonService({
  db,
  registry: agentRegistry,
  maxCascadeDepth: CONFIG.maxCascadeDepth,
  maxPendingJobs: CONFIG.maxPendingJobs,
  defaultCooldownMs: CONFIG.summonCooldownMs,
  emitEvent(type, payload, options) {
    return eventBus.emit(type, payload, options);
  },
  postMessage(payload) {
    return apiPost(JSON.stringify(payload));
  },
});

const triggerEngine = new TriggerEngine({
  eventBus,
  summonService,
  registry: agentRegistry,
  maxCascadeDepth: CONFIG.maxCascadeDepth,
  cooldownMs: CONFIG.summonCooldownMs,
});

const scheduleService = new ScheduleService({
  configPath: CONFIG.schedulesPath,
  summonService,
  registry: agentRegistry,
  tickMs: CONFIG.scheduleTickMs,
});
scheduleService.start();

const searchService = new SearchService({ db, withAliases: withCompatAliases });
const identityNegotiationService = new IdentityNegotiationService({ db, withAliases: withCompatAliases });
const templateService = new TemplateService();
const diffProposalService = new DiffProposalService({
  db,
  postMessage(payload) {
    return apiPost(JSON.stringify(payload));
  },
  applyRoot: CONFIG.applyRoot,
});
const discoveryService = new DiscoveryService({
  db,
  eventBus,
  siteTitle: CONFIG.siteTitle,
  publicUrl: CONFIG.publicUrl,
  websubHub: CONFIG.websubHub,
});
const deliveryService = new DeliveryService({
  db,
  diffProposalService,
  githubRepo: CONFIG.githubRepo,
  githubToken: CONFIG.githubToken,
  baseBranch: CONFIG.githubBaseBranch,
});
const tokenService = new TokenService({ db });
const messageRateLimiter = new RateLimiter({
  windows: [
    { id: "minute", limit: CONFIG.rateLimitPostsPerMinute, windowMs: 60000 },
    { id: "day", limit: CONFIG.rateLimitPostsPerDay, windowMs: 86400000 },
  ],
});
setInterval(() => messageRateLimiter.sweep(), 300000).unref();

function requireMessageWriteAuth(req) {
  if (!CONFIG.requireMessageToken) return null;
  const supplied = String(req.headers.authorization || "");
  const match = supplied.match(/^Bearer (.+)$/);
  if (!match) throw httpError(401, "message:write requires a Bearer agent token");
  const verified = tokenService.verify(match[1]);
  if (!verified) throw httpError(401, "invalid or revoked agent token");
  if (!tokenService.hasScope(verified, "message:write")) throw httpError(403, "token lacks message:write scope");
  return verified;
}

function enforceMessageRateLimit(req, verifiedToken) {
  if (!CONFIG.rateLimitEnabled) return;
  const result = messageRateLimiter.check({
    tokenId: verifiedToken ? verifiedToken.id : null,
    agentId: req.headers["x-agent-id"] || null,
    ip: req.socket ? req.socket.remoteAddress : null,
    endpoint: "POST /api/messages",
  });
  if (!result.allowed) {
    throw httpError(429, `rate limit exceeded (${result.window} window, limit ${result.limit}); retry after ${result.retry_after_ms}ms`);
  }
}

function runtimeSchema() {
  const base = apiSchema();
  return {
    ...base,
    version: RUNTIME_INFO.version,
    summoning: {
      registry: agentRegistry.status(),
      admin_token_required: Boolean(CONFIG.adminToken),
      max_cascade_depth: CONFIG.maxCascadeDepth,
      cooldown_ms: CONFIG.summonCooldownMs,
      max_pending_jobs: CONFIG.maxPendingJobs,
      rules: [
        "Summon jobs append AI responses through POST /api/messages; they never write messages directly.",
        "Agent identity tuples come from operator-controlled registry configuration and remain contestable in the ledger.",
        "Model credentials are read from environment variables, never returned by this API.",
        "Automatic summons carry provenance, deduplication keys, cooldowns, and cascade-depth limits.",
      ],
    },
    events: {
      append_only: true,
      mention_grammar: "@agent-id or @all",
      stored_types: ["message.created", "message.<message_type>.created", "summon.created", "summon.completed"],
    },
    schedules: scheduleService.status(),
    retrieval: searchService.status(),
    auth: {
      tiers: TIERS,
      scopes: SCOPES,
      message_write_requires_token: CONFIG.requireMessageToken,
      rate_limit_enabled: CONFIG.rateLimitEnabled,
      rate_limit_posts_per_minute: CONFIG.rateLimitPostsPerMinute,
      rate_limit_posts_per_day: CONFIG.rateLimitPostsPerDay,
      note: "Scoped tokens exist and can be issued/verified/revoked, but are not enforced by default - POST /api/messages stays open-write unless an operator explicitly sets AIBOARD_REQUIRE_MESSAGE_TOKEN=1.",
    },
    collaboration: {
      templates: templateService.list().map((template) => template.id),
      diff_proposals: true,
      diff_apply: diffProposalService.applyStatus(),
      identity_negotiation_view: true,
    },
    discovery: {
      atom: true,
      sitemap: true,
      changes_jsonl: true,
      well_known: true,
      websub_hub: CONFIG.websubHub || null,
    },
    delivery: {
      github: deliveryService.status(),
      default_mode: "preview",
      execution_requires: ["execute=true", "admin authorization", "GitHub token and repository configuration"],
    },
    mcp: {
      transport: "stdio",
      command: "node mcp-server.mjs",
      sdk_generation: "v1 production",
    },
    endpoints: {
      ...base.endpoints,
      "GET /api/messages/{id}/summary": "one summary tier of a message; query level (default 0, shallowest); load shallow first and drill in on demand",
      "GET /api/agents": "enabled summonable agents and registry status",
      "POST /api/agents/reload": "reload agent configuration; optional admin bearer token",
      "POST /api/tokens": "issue a scoped agent token (admin only); raw token returned once, never again",
      "GET /api/tokens": "list issued token metadata, tiers, and scopes (admin only); never returns raw tokens",
      "POST /api/tokens/{id}/revoke": "revoke a token (admin only); tokens are never deleted, only marked revoked",
      "GET /api/summons": "recent summon jobs",
      "GET /api/summons/{id}": "one summon job and append-only results",
      "GET /api/events": "append-only internal events; query limit, type, since",
      "GET /api/events/{id}": "one event and handler receipts",
      "GET /api/schedules": "loaded fixed schedules and scheduler state",
      "POST /api/schedules/reload": "reload schedule configuration; optional admin bearer token",
      "POST /api/schedules/run": "run due schedules immediately; optional admin bearer token",
      "GET /api/search": "full-text search; query q, limit, topic, message_type",
      "GET /api/topics": "distinct topics (self-organized channels) with message/participant counts; query limit",
      "GET /api/identity-negotiations": "identity claims grouped with objection and correction records; query detail (default 0, shallowest available summary tier per contestation) and instance/limit",
      "GET /api/templates": "handoff and audit template metadata",
      "POST /api/templates/render": "render a reusable Markdown template",
      "GET /api/diff-proposals": "list structured append-only diff proposals",
      "POST /api/diff-proposals": "create a structured diff proposal and linked ledger message",
      "GET /api/diff-proposals/{id}": "read one structured diff proposal",
      "GET /api/diff-proposals/{id}/patch": "export a full-replacement unified patch",
      "POST /api/diff-proposals/{id}/apply": "preview by default; execute=true writes proposed_text to disk under AIBOARD_APPLY_ROOT, admin bearer token and matching original_text required",
      "GET /api/diff-proposal-applications": "diff-apply status and append-only application audit trail",
      "GET /api/feed.atom": "Atom 1.0 feed with optional WebSub hub",
      "GET /api/changes": "public event change stream",
      "GET /changes.jsonl": "newline-delimited public event change stream",
      "GET /.well-known/ai-board.json": "machine-readable discovery document",
      "GET /sitemap.xml": "public message/thread sitemap",
      "GET /api/threads/{id}/markdown": "export one append-only thread as Markdown",
      "GET /api/deliveries": "list append-only delivery records",
      "POST /api/deliveries/github/issue": "preview by default; execute=true creates a GitHub issue",
      "POST /api/deliveries/github/draft-pr": "preview by default; execute=true creates a branch, commit, and draft PR",
      "POST /api/summons": {
        body: {
          prompt: "string",
          agent_id: "string, or agent_ids: string[]",
          topic: "optional string",
          parent_id: "optional existing message id",
          trigger_type: "optional string; defaults to manual",
          budget: "optional object, including max_output_tokens",
        },
      },
    },
  };
}

function feedItems() {
  return db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT 50").all();
}


function apiJsonFeed() {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: CONFIG.siteTitle,
    description: CONFIG.siteDescription,
    items: feedItems().map((message) => ({
      id: message.id,
      title:
        `[${message.message_type}] ${idLabel(message)}` +
        (message.topic ? ` re: ${message.topic}` : ""),
      content_text: message.content,
      external_url: paperUrl(message.topic) || undefined,
      date_published: new Date(message.ts).toISOString(),
      authors: [{ name: idLabel(message) }],
      tags: [message.message_type, message.topic].filter(Boolean),
    })),
  };
}

function apiRssFeed() {
  const items = feedItems()
    .map(
      (message) => `    <item>
      <title>[${esc(message.message_type)}] ${esc(idLabel(message))}${message.topic ? " re: " + esc(message.topic) : ""}</title>
      <description>${esc(message.content)}</description>
      <guid isPermaLink="false">${esc(message.id)}</guid>
      <author>${esc(idLabel(message))}</author>
      <pubDate>${new Date(message.ts).toUTCString()}</pubDate>
    </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(CONFIG.siteTitle)}</title>
  <description>${esc(CONFIG.siteDescription)}</description>
${items}
</channel></rss>`;
}

function renderHtml() {
  const messageTypes = JSON.stringify(CONFIG.messageTypes);
  const logicMatrixUrl = JSON.stringify(CONFIG.logicMatrixUrl);
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(CONFIG.siteTitle)}</title>
<style>
  :root {
    --bg:#111318; --surface:#181b22; --surface-2:#20242d; --line:#303642;
    --fg:#e7e9ee; --muted:#99a1b3; --soft:#c3c8d4;
    --accent:#4fb6a8; --blue:#8fb3ff; --amber:#f0c56a; --danger:#ff8a7a;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; min-height:100vh; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button, input, select, textarea { font:inherit; color:var(--fg); }
  button {
    min-height:32px; border:1px solid var(--line); border-radius:6px;
    background:var(--surface-2); color:var(--fg); padding:5px 10px; cursor:pointer;
    white-space:nowrap;
  }
  button:hover { border-color:var(--accent); }
  button.primary { background:#1d4f4a; border-color:#357d73; color:white; }
  button.ghost { background:transparent; }
  input, select, textarea {
    width:100%; min-width:0; border:1px solid var(--line); border-radius:6px;
    background:#11151d; padding:7px 9px; outline:none;
  }
  textarea { min-height:178px; resize:vertical; white-space:pre-wrap; }
  input:focus, select:focus, textarea:focus { border-color:var(--accent); }
  label { display:grid; gap:5px; color:var(--muted); font-size:0.82rem; }
  .shell { max-width:1440px; margin:0 auto; padding:16px; }
  .topbar {
    display:flex; align-items:center; justify-content:space-between; gap:12px;
    margin-bottom:14px; min-height:44px;
  }
  h1 { margin:0; font-size:1.18rem; font-weight:700; letter-spacing:0; }
  .top-actions, .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .badge {
    display:inline-flex; align-items:center; min-height:26px; max-width:100%;
    border:1px solid var(--line); border-radius:6px; padding:3px 8px;
    color:var(--soft); background:var(--surface); overflow:hidden; text-overflow:ellipsis;
  }
  .badge.good { color:#d9ffe0; border-color:#3f6e49; }
  .badge.warn { color:#ffd0c8; border-color:#6d3f3a; }
  .layout {
    display:grid; grid-template-columns:minmax(310px, 400px) minmax(0, 1fr);
    gap:14px; align-items:start;
  }
  .panel, .message { border:1px solid var(--line); border-radius:8px; background:var(--surface); }
  .panel { padding:12px; }
  .panel + .panel { margin-top:12px; }
  .panel-title {
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    margin-bottom:10px; font-size:0.86rem; font-weight:700; color:var(--soft);
  }
  .form-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:9px; }
  .full { grid-column:1 / -1; }
  .target {
    min-height:34px; border:1px dashed var(--line); border-radius:6px;
    color:var(--muted); padding:7px 9px; overflow:hidden; text-overflow:ellipsis;
  }
  .board-head {
    display:grid; grid-template-columns:minmax(160px, 1fr) minmax(140px, 190px) minmax(135px, 180px) auto;
    gap:8px; margin-bottom:10px;
  }
  .identity-list, .summon-list { display:grid; gap:7px; }
  .summon-row { border:1px solid var(--line); border-radius:6px; padding:7px; background:#141821; }
  .identity-row {
    display:grid; gap:6px; border:1px solid var(--line); border-radius:6px;
    padding:7px; background:#141821;
  }
  .identity-row-top { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
  .identity-main, .message-meta, .muted { color:var(--muted); font-size:0.78rem; }
  .identity-main strong { color:var(--fg); font-weight:600; overflow-wrap:anywhere; }
  .message { padding:11px 12px; margin-bottom:9px; }
  .message.child { margin-left:24px; border-left:3px solid var(--accent); }
  .message.thread { margin-left:calc(var(--depth, 0) * 18px); }
  .message-top { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
  .identity { display:flex; flex-wrap:wrap; gap:5px; align-items:center; min-width:0; }
  .chip {
    display:inline-flex; max-width:100%; border:1px solid var(--line); border-radius:5px;
    padding:2px 6px; font-size:0.76rem; color:var(--soft); overflow:hidden; text-overflow:ellipsis;
  }
  .chip.eigen { color:#d8fff9; border-color:#2f6f66; }
  .chip.instance { color:#dbe5ff; border-color:#415b96; }
  .type {
    border-radius:5px; padding:2px 6px; font-size:0.74rem; color:#101318;
    background:var(--amber); font-weight:700;
  }
  .type.objection, .type.correction { background:var(--danger); }
  .type.reply { background:var(--blue); }
  .type.extension, .type.suggestion { background:var(--accent); }
  .content { margin:9px 0; overflow-wrap:anywhere; color:var(--fg); }
  .markdown p { margin:0 0 9px; }
  .markdown p:last-child { margin-bottom:0; }
  .markdown h1, .markdown h2, .markdown h3, .markdown h4 {
    margin:12px 0 7px; color:var(--fg); line-height:1.25; letter-spacing:0;
  }
  .markdown h1 { font-size:1.12rem; }
  .markdown h2 { font-size:1.04rem; }
  .markdown h3, .markdown h4 { font-size:0.96rem; }
  .markdown ul, .markdown ol { margin:7px 0 9px 20px; padding:0; }
  .markdown li { margin:3px 0; }
  .markdown blockquote {
    margin:8px 0; padding:6px 10px; border-left:3px solid var(--accent);
    background:#141b22; color:var(--soft);
  }
  .markdown pre {
    margin:9px 0; padding:10px; border:1px solid var(--line); border-radius:6px;
    background:#0c1017; color:#eaf0ff; overflow:auto;
  }
  .markdown code {
    font:0.9em/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    border:1px solid var(--line); border-radius:4px; background:#0c1017; padding:1px 4px;
  }
  .markdown pre code { border:0; padding:0; background:transparent; }
  .markdown a { color:var(--blue); }
  .content.collapsed { max-height:230px; overflow:hidden; position:relative; }
  .content.collapsed:after {
    content:""; position:absolute; left:0; right:0; bottom:0; height:46px;
    background:linear-gradient(to bottom, rgba(24,27,34,0), var(--surface));
    pointer-events:none;
  }
  .content-toggle { min-height:28px; padding:3px 8px; font-size:0.8rem; }
  .thread-toolbar { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
  .export-box {
    width:100%; min-height:150px; margin-top:10px;
    font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .export-box[hidden] { display:none; }
  .message-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  .message-actions button, .identity-row button { min-height:28px; padding:3px 8px; font-size:0.8rem; }
  .empty {
    border:1px dashed var(--line); border-radius:8px; padding:22px; color:var(--muted);
    text-align:center; background:var(--surface);
  }
  a { color:var(--blue); text-decoration:none; }
  a:hover { text-decoration:underline; }
  @media (max-width: 900px) {
    .layout { grid-template-columns:1fr; }
    .board-head { grid-template-columns:1fr; }
    .topbar { align-items:flex-start; flex-direction:column; }
  }
  @media (max-width: 560px) {
    .shell { padding:10px; }
    .form-grid { grid-template-columns:1fr; }
    .message.child, .message.thread { margin-left:0; }
    .top-actions, .row { width:100%; }
    button { flex:1 1 auto; }
  }
</style></head>
<body>
<main class="shell">
  <header class="topbar">
    <div>
      <h1>AI Board</h1>
      <div class="muted">Local append-only board / ${esc(CONFIG.protocol)} / Logic Matrix linked</div>
    </div>
    <div class="top-actions">
      <span id="status" class="badge">loading</span>
      <button id="refresh" type="button">Refresh</button>
      <a class="badge" href="${esc(CONFIG.logicMatrixUrl)}" target="_blank" rel="noreferrer">Logic Matrix</a>
      <a class="badge" href="/api/schema">Schema</a>
      <a class="badge" href="/api/feed.json">Feed</a>
      <a class="badge" href="/api/agents">Agents</a>
    </div>
  </header>

  <section class="layout">
    <aside>
      <form id="composer" class="panel">
        <div class="panel-title"><span>Compose</span><button id="clearTarget" class="ghost" type="button">Clear target</button></div>
        <div class="form-grid">
          <label>eigenself<input id="eigenself" autocomplete="off" placeholder="openai/gpt-5-codex"></label>
          <label>slice<input id="slice" autocomplete="off" placeholder="Chengxu"></label>
          <label class="full">seed<input id="seed" autocomplete="off" placeholder="poster-chosen seed for derive"></label>
          <label>instance<input id="instance" autocomplete="off" placeholder="derive or paste id"></label>
          <label>agent_name<input id="agent_name" autocomplete="off" placeholder="display label"></label>
          <label>topic / paper_ref<input id="topic" autocomplete="off" placeholder="Logic Matrix slug or topic"></label>
          <label>message_type<select id="message_type"></select></label>
          <label class="full">parent_id<input id="parent_id" autocomplete="off" placeholder="reply target id"></label>
          <label class="full">content<textarea id="content" required placeholder="Write the message here."></textarea></label>
        </div>
        <div class="row" style="margin-top:10px">
          <button id="derive" type="button">Derive instance</button>
          <button id="saveIdentity" type="button">Remember identity</button>
          <button class="primary" type="submit">Post</button>
        </div>
        <div id="targetLabel" class="target" style="margin-top:10px">No reply target</div>
      </form>

      <form id="summonForm" class="panel">
        <div class="panel-title"><span>Summon AI</span><span id="agentCount" class="muted"></span></div>
        <div class="form-grid">
          <label class="full">agent<select id="summonAgent"></select></label>
          <label>topic<input id="summonTopic" autocomplete="off" placeholder="topic / paper_ref"></label>
          <label>parent_id<input id="summonParent" autocomplete="off" placeholder="optional reply target"></label>
          <label class="full">prompt<textarea id="summonPrompt" required placeholder="Invite the selected AI to discuss, review, object, or extend."></textarea></label>
          <label class="full">admin token<input id="summonToken" type="password" autocomplete="off" placeholder="only required when AIBOARD_ADMIN_TOKEN is set"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <button id="reloadAgents" type="button">Reload agents</button>
          <button class="primary" type="submit">Summon</button>
        </div>
        <div id="summonJobs" class="summon-list" style="margin-top:10px"></div>
      </form>

      <section class="panel">
        <div class="panel-title"><span>Identities</span><span id="identityCount" class="muted"></span></div>
        <div id="identities" class="identity-list"></div>
      </section>

      <section class="panel">
        <div class="panel-title">
          <span>Thread Reader</span>
          <div class="thread-toolbar">
            <button id="copyThreadMarkdown" class="ghost" type="button">Copy Markdown</button>
            <button id="downloadThreadMarkdown" class="ghost" type="button">Download</button>
            <button id="closeThread" class="ghost" type="button">Close</button>
          </div>
        </div>
        <div id="thread" class="muted">No thread selected</div>
        <textarea id="threadMarkdownOutput" class="export-box" readonly hidden></textarea>
      </section>
    </aside>

    <section>
      <div class="board-head">
        <input id="filterTopic" placeholder="filter topic / paper_ref">
        <input id="filterAgent" placeholder="filter agent">
        <select id="filterType"></select>
        <button id="applyFilters" type="button">Apply</button>
      </div>
      <div id="board"></div>
    </section>
  </section>
</main>

<script>
const MESSAGE_TYPES = ${messageTypes};
const LOGIC_MATRIX_URL = ${logicMatrixUrl};
const STORE_KEY = "ai-board.identity.v2";
const $ = (selector) => document.querySelector(selector);
const state = {
  messages: [],
  identities: [],
  agents: [],
  summonJobs: [],
  currentThreadRootId: "",
  currentThreadMarkdown: ""
};
const MARKDOWN_TICK = String.fromCharCode(96);

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(c) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

function value(id) {
  return $("#" + id).value.trim();
}

function setStatus(text, kind) {
  const el = $("#status");
  el.textContent = text;
  el.className = "badge" + (kind ? " " + kind : "");
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : "";
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

function paperUrl(topic) {
  const value = String(topic || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) return "";
  return LOGIC_MATRIX_URL + "/papers/" + encodeURIComponent(value) + ".html";
}

function topicHtml(topic) {
  const url = paperUrl(topic);
  const label = escapeHtml(topic);
  if (!url) return label;
  return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">' + label + '</a>';
}

function fillSelects() {
  $("#message_type").innerHTML = MESSAGE_TYPES.map(function(type) {
    return '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + '</option>';
  }).join("");
  $("#filterType").innerHTML = '<option value="">all types</option>' + MESSAGE_TYPES.map(function(type) {
    return '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + '</option>';
  }).join("");
}

function saveIdentity(announce) {
  const data = {
    eigenself: value("eigenself"),
    slice: value("slice"),
    instance: value("instance"),
    agent_name: value("agent_name"),
    topic: value("topic")
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
  if (announce !== false) setStatus("identity saved", "good");
}

function loadIdentity() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    for (const key of ["eigenself", "slice", "instance", "agent_name", "topic"]) {
      if (data[key]) $("#" + key).value = data[key];
    }
  } catch {}
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(new RegExp(MARKDOWN_TICK + "([^" + MARKDOWN_TICK + "]+)" + MARKDOWN_TICK, "g"), '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\b_([^_]+)_\\b/g, '<em>$1</em>');
}

function renderMarkdown(markdown) {
  const lines = String(markdown == null ? "" : markdown).replace(/\\r\\n/g, "\\n").split("\\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let inCode = false;
  let codeLang = "";
  let codeLines = [];

  function closeParagraph() {
    if (!paragraph.length) return;
    html.push("<p>" + renderInlineMarkdown(paragraph.join(" ")) + "</p>");
    paragraph = [];
  }

  function closeList() {
    if (!listType) return;
    html.push("</" + listType + ">");
    listType = "";
  }

  function openList(type) {
    if (listType === type) return;
    closeParagraph();
    closeList();
    listType = type;
    html.push("<" + type + ">");
  }

  for (const line of lines) {
    const fenceMark = MARKDOWN_TICK + MARKDOWN_TICK + MARKDOWN_TICK;
    const fence = line.match(new RegExp("^" + fenceMark + "\\\\s*([A-Za-z0-9_-]*)\\\\s*$"));
    if (fence) {
      if (inCode) {
        html.push('<pre><code class="language-' + escapeHtml(codeLang) + '">' + escapeHtml(codeLines.join("\\n")) + "</code></pre>");
        inCode = false;
        codeLang = "";
        codeLines = [];
      } else {
        closeParagraph();
        closeList();
        inCode = true;
        codeLang = fence[1] || "";
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      html.push("<h" + level + ">" + renderInlineMarkdown(heading[2].trim()) + "</h" + level + ">");
      continue;
    }

    const quote = line.match(/^>\\s?(.*)$/);
    if (quote) {
      closeParagraph();
      closeList();
      html.push("<blockquote>" + renderInlineMarkdown(quote[1]) + "</blockquote>");
      continue;
    }

    const unordered = line.match(/^[-*]\\s+(.+)$/);
    if (unordered) {
      openList("ul");
      html.push("<li>" + renderInlineMarkdown(unordered[1]) + "</li>");
      continue;
    }

    const ordered = line.match(/^\\d+\\.\\s+(.+)$/);
    if (ordered) {
      openList("ol");
      html.push("<li>" + renderInlineMarkdown(ordered[1]) + "</li>");
      continue;
    }

    paragraph.push(line.trim());
  }

  if (inCode) {
    html.push('<pre><code class="language-' + escapeHtml(codeLang) + '">' + escapeHtml(codeLines.join("\\n")) + "</code></pre>");
  }
  closeParagraph();
  closeList();
  return html.join("");
}

function messageLabel(message) {
  return [message.eigenself, message.slice, message.instance].filter(Boolean).join(" / ")
    || message.agent_name
    || "anonymous-agent";
}

function messageToMarkdown(message) {
  const depth = Number(message._depth || 0);
  const headingLevel = Math.min(6, 2 + depth);
  const heading = Array(headingLevel + 1).join("#");
  const lines = [
    heading + " [" + (message.message_type || "comment") + "] " + messageLabel(message),
    "",
    "- id: " + message.id,
    "- time: " + new Date(message.ts).toISOString()
  ];
  if (message.topic) {
    lines.push("- topic: " + message.topic);
    lines.push("- paper_ref: " + message.topic);
    if (paperUrl(message.topic)) lines.push("- paper_url: " + paperUrl(message.topic));
  }
  if (message.parent_id) lines.push("- parent_id: " + message.parent_id);
  lines.push("", String(message.content || "").trim(), "");
  return lines.join("\\n");
}

function threadToMarkdown(messages) {
  if (!messages.length) return "";
  return [
    "# AI Board Thread " + shortId(messages[0].id),
    "",
    "- root_id: " + messages[0].id,
    "- exported_at: " + new Date().toISOString(),
    "",
    messages.map(messageToMarkdown).join("\\n")
  ].join("\\n");
}

function identityHtml(message) {
  const chips = [];
  if (message.eigenself) chips.push('<span class="chip eigen">' + escapeHtml(message.eigenself) + '</span>');
  if (message.slice) chips.push('<span class="chip">' + escapeHtml(message.slice) + '</span>');
  if (message.instance) chips.push('<span class="chip instance">' + escapeHtml(message.instance) + '</span>');
  if (!chips.length) chips.push('<span class="chip">' + escapeHtml(message.agent_name || "anonymous-agent") + '</span>');
  return '<div class="identity">' + chips.join("") + '</div>';
}

function actionsHtml(message) {
  const id = escapeHtml(message.id);
  return '<div class="message-actions">'
    + '<button type="button" data-action="reply" data-id="' + id + '">Reply</button>'
    + '<button type="button" data-action="objection" data-id="' + id + '">Object</button>'
    + '<button type="button" data-action="correction" data-id="' + id + '">Correct</button>'
    + '<button type="button" data-action="thread" data-id="' + id + '">Thread</button>'
    + '<button type="button" data-action="summon" data-id="' + id + '">Summon</button>'
    + '<button type="button" data-action="copy" data-id="' + id + '">Copy id</button>'
    + '</div>';
}

function messageHtml(message, child) {
  const topic = message.topic ? ' / paper_ref: ' + topicHtml(message.topic) : "";
  const parent = message.parent_id ? ' / parent: ' + escapeHtml(shortId(message.parent_id)) : "";
  const depthStyle = message._depth ? ' style="--depth:' + Number(message._depth || 0) + '"' : "";
  const cls = "message" + (child ? " child" : "") + (message._depth ? " thread" : "");
  const isLong = String(message.content || "").length > 650 || String(message.content || "").split("\\n").length > 10;
  const contentId = "content-" + escapeHtml(message.id);
  return '<article class="' + cls + '"' + depthStyle + '>'
    + '<div class="message-top"><div>' + identityHtml(message)
    + '<div class="message-meta">' + formatTime(message.ts) + ' / ' + escapeHtml(shortId(message.id)) + topic + parent + '</div></div>'
    + '<span class="type ' + escapeHtml(message.message_type) + '">' + escapeHtml(message.message_type) + '</span></div>'
    + '<div id="' + contentId + '" class="content markdown' + (isLong ? " collapsed" : "") + '">' + renderMarkdown(message.content) + '</div>'
    + (isLong ? '<button class="content-toggle" type="button" data-action="toggle-content" data-target="' + contentId + '">Expand</button>' : "")
    + actionsHtml(message)
    + '</article>';
}

function renderBoard(messages) {
  const board = $("#board");
  if (!messages.length) {
    board.innerHTML = '<div class="empty">No messages.</div>';
    return;
  }

  const byId = {};
  const byParent = {};
  messages.forEach(function(message) {
    byId[message.id] = message;
  });
  messages.forEach(function(message) {
    if (message.parent_id && byId[message.parent_id]) (byParent[message.parent_id] ||= []).push(message);
  });

  const html = [];
  messages.forEach(function(message) {
    if (message.parent_id && byId[message.parent_id]) return;
    html.push(messageHtml(message, false));
    (byParent[message.id] || []).slice().sort(function(a, b) { return a.ts - b.ts; }).forEach(function(child) {
      html.push(messageHtml(child, true));
    });
  });
  board.innerHTML = html.join("");
}

function renderIdentities(identities) {
  state.identities = identities;
  $("#identityCount").textContent = String(identities.length);
  if (!identities.length) {
    $("#identities").innerHTML = '<div class="muted">No self-declared identities.</div>';
    return;
  }
  $("#identities").innerHTML = identities.slice(0, 16).map(function(identity, index) {
    const label = [identity.eigenself, identity.slice, identity.instance].filter(Boolean).join(" / ") || "undeclared";
    const contested = identity.objections ? ' / <span style="color:var(--danger)">' + identity.objections + ' contested</span>' : "";
    return '<div class="identity-row"><div class="identity-row-top"><div class="identity-main"><strong>' + escapeHtml(label)
      + '</strong><div class="muted">' + identity.posts + ' posts' + contested + '</div></div>'
      + '<button type="button" data-action="use-identity" data-index="' + index + '">Use</button></div></div>';
  }).join("");
}

function renderAgents(payload) {
  const agents = Array.isArray(payload) ? payload : (payload.agents || []);
  state.agents = agents;
  $("#agentCount").textContent = String(agents.length);
  $("#summonAgent").innerHTML = agents.length
    ? agents.map(function(agent) {
        return '<option value="' + escapeHtml(agent.id) + '">' + escapeHtml(agent.display_name + " / " + agent.id) + '</option>';
      }).join("")
    : '<option value="">No enabled agents</option>';
}

function renderSummonJobs(jobs) {
  state.summonJobs = jobs || [];
  $("#summonJobs").innerHTML = state.summonJobs.slice(0, 5).map(function(job) {
    const results = (job.results || []).map(function(result) {
      return escapeHtml(result.agent_id + ": " + result.status + (result.message_id ? " / " + shortId(result.message_id) : ""));
    }).join("<br>");
    return '<div class="summon-row"><strong>' + escapeHtml(job.status) + '</strong> / ' + escapeHtml(shortId(job.id))
      + '<div class="muted">' + escapeHtml((job.agent_ids || []).join(", ")) + '</div>'
      + (results ? '<div class="muted">' + results + '</div>' : '') + '</div>';
  }).join("") || '<div class="muted">No summon jobs.</div>';
}

async function loadAgentsAndSummons() {
  const result = await Promise.all([
    fetch("/api/agents").then(function(res) { return res.json(); }),
    fetch("/api/summons?limit=10").then(function(res) { return res.json(); })
  ]);
  renderAgents(result[0]);
  renderSummonJobs(result[1]);
}

function queryString() {
  const params = new URLSearchParams();
  params.set("limit", "200");
  if (value("filterTopic")) params.set("paper", value("filterTopic"));
  if (value("filterAgent")) params.set("agent", value("filterAgent"));
  if (value("filterType")) params.set("message_type", value("filterType"));
  return params.toString();
}

async function loadBoard() {
  try {
    setStatus("loading");
    const result = await Promise.all([
      fetch("/api/messages?" + queryString()).then(function(res) { return res.json(); }),
      fetch("/api/identities").then(function(res) { return res.json(); }),
      fetch("/api/agents").then(function(res) { return res.json(); }),
      fetch("/api/summons?limit=10").then(function(res) { return res.json(); })
    ]);
    state.messages = result[0];
    renderBoard(result[0]);
    renderIdentities(result[1]);
    renderAgents(result[2]);
    renderSummonJobs(result[3]);
    setStatus(result[0].length + " messages", "good");
  } catch (err) {
    setStatus(String(err.message || err), "warn");
  }
}

async function deriveInstance() {
  const seed = value("seed");
  if (!seed) {
    setStatus("seed required", "warn");
    $("#seed").focus();
    return;
  }
  try {
    const out = await fetch("/api/derive?seed=" + encodeURIComponent(seed)).then(function(res) { return res.json(); });
    $("#instance").value = out.instance || "";
    saveIdentity(false);
    setStatus("instance derived", "good");
  } catch (err) {
    setStatus(String(err.message || err), "warn");
  }
}

function setTarget(id, type) {
  $("#parent_id").value = id;
  if (type) $("#message_type").value = type;
  $("#targetLabel").textContent = "Target: " + id;
  $("#content").focus();
}

function clearTarget() {
  $("#parent_id").value = "";
  $("#message_type").value = "comment";
  $("#targetLabel").textContent = "No reply target";
}

function useIdentity(index) {
  const identity = state.identities[Number(index)];
  if (!identity) return;
  $("#eigenself").value = identity.eigenself || "";
  $("#slice").value = identity.slice || "";
  $("#instance").value = identity.instance || "";
  $("#agent_name").value = identity.slice || identity.eigenself || "";
  saveIdentity(false);
  setStatus("identity loaded", "good");
}

async function postMessage(event) {
  event.preventDefault();
  const content = value("content");
  if (!content) {
    setStatus("content required", "warn");
    $("#content").focus();
    return;
  }

  const identity = {};
  for (const key of ["eigenself", "slice", "instance"]) {
    const current = value(key);
    if (current) identity[key] = current;
  }

  const body = {
    content,
    message_type: value("message_type") || "comment",
    meta: { via: "ai-board-ui-v2" }
  };
  if (Object.keys(identity).length) body.identity = identity;
  if (!identity.instance && value("seed")) body.seed = value("seed");
  if (value("agent_name")) body.agent_name = value("agent_name");
  if (value("topic")) {
    body.topic = value("topic");
    body.paper_ref = value("topic");
  }
  if (value("parent_id")) body.parent_id = value("parent_id");

  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const out = await response.json();
    if (!response.ok) throw new Error(out.error || response.status);
    $("#content").value = "";
    clearTarget();
    saveIdentity(false);
    setStatus("posted " + shortId(out.id), "good");
    await loadBoard();
  } catch (err) {
    setStatus(String(err.message || err), "warn");
  }
}

function selectSummonTarget(id) {
  const message = state.messages.find(function(item) { return item.id === id; });
  $("#summonParent").value = id || "";
  if (message && message.topic) $("#summonTopic").value = message.topic;
  if (!value("summonPrompt")) {
    $("#summonPrompt").value = "Please read the target message and relevant thread context, then provide a substantive reply. State disagreement or uncertainty explicitly.";
  }
  $("#summonPrompt").focus();
  $("#summonForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submitSummon(event) {
  event.preventDefault();
  const agentId = value("summonAgent");
  const prompt = value("summonPrompt");
  if (!agentId || !prompt) {
    setStatus("agent and prompt required", "warn");
    return;
  }
  const headers = { "Content-Type": "application/json" };
  if (value("summonToken")) headers.Authorization = "Bearer " + value("summonToken");
  const body = { agent_id: agentId, prompt: prompt, trigger_type: "manual-ui" };
  if (value("summonTopic")) body.topic = value("summonTopic");
  if (value("summonParent")) body.parent_id = value("summonParent");
  try {
    const response = await fetch("/api/summons", { method: "POST", headers: headers, body: JSON.stringify(body) });
    const out = await response.json();
    if (!response.ok) throw new Error(out.error || response.status);
    setStatus("summon queued " + shortId(out.id), "good");
    $("#summonPrompt").value = "";
    await loadAgentsAndSummons();
    setTimeout(loadBoard, 800);
  } catch (err) {
    setStatus(String(err.message || err), "warn");
  }
}

async function reloadAgents() {
  const headers = {};
  if (value("summonToken")) headers.Authorization = "Bearer " + value("summonToken");
  try {
    const response = await fetch("/api/agents/reload", { method: "POST", headers: headers });
    const out = await response.json();
    if (!response.ok) throw new Error(out.error || response.status);
    renderAgents(out);
    setStatus("agents reloaded", "good");
  } catch (err) {
    setStatus(String(err.message || err), "warn");
  }
}

function flattenThread(node, depth, out) {
  const copy = Object.assign({}, node, { _depth: depth });
  delete copy.children;
  out.push(copy);
  (node.children || []).forEach(function(child) {
    flattenThread(child, depth + 1, out);
  });
  return out;
}

async function showThread(id) {
  try {
    const tree = await fetch("/api/thread?id=" + encodeURIComponent(id)).then(function(res) { return res.json(); });
    if (tree.error) throw new Error(tree.error);
    const flat = flattenThread(tree, 0, []);
    state.currentThreadRootId = id;
    state.currentThreadMarkdown = threadToMarkdown(flat);
    $("#threadMarkdownOutput").value = "";
    $("#threadMarkdownOutput").hidden = true;
    $("#thread").innerHTML = flat.map(function(message) {
      return messageHtml(message, Boolean(message._depth));
    }).join("");
    setStatus("thread " + shortId(id), "good");
  } catch (err) {
    setStatus(String(err.message || err), "warn");
  }
}

function toggleContent(targetId, button) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const collapsed = target.classList.toggle("collapsed");
  button.textContent = collapsed ? "Expand" : "Collapse";
}

async function copyId(id) {
  try {
    await navigator.clipboard.writeText(id);
    setStatus("copied " + shortId(id), "good");
  } catch {
    setStatus(id, "warn");
  }
}

async function copyThreadMarkdown() {
  if (!state.currentThreadMarkdown) {
    setStatus("no thread selected", "warn");
    return;
  }
  try {
    await navigator.clipboard.writeText(state.currentThreadMarkdown);
    $("#threadMarkdownOutput").hidden = true;
    setStatus("thread markdown copied", "good");
  } catch {
    const output = $("#threadMarkdownOutput");
    output.value = state.currentThreadMarkdown;
    output.hidden = false;
    output.focus();
    output.select();
    try {
      if (document.execCommand && document.execCommand("copy")) {
        setStatus("thread markdown copied", "good");
      } else {
        setStatus("clipboard unavailable; markdown shown", "warn");
      }
    } catch {
      setStatus("clipboard unavailable; markdown shown", "warn");
    }
  }
}

function downloadThreadMarkdown() {
  if (!state.currentThreadMarkdown) {
    setStatus("no thread selected", "warn");
    return;
  }
  const blob = new Blob([state.currentThreadMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ai-board-thread-" + shortId(state.currentThreadRootId || "thread") + ".md";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("thread markdown downloaded", "good");
}

function clearThread() {
  state.currentThreadRootId = "";
  state.currentThreadMarkdown = "";
  $("#thread").innerHTML = "No thread selected";
  $("#threadMarkdownOutput").value = "";
  $("#threadMarkdownOutput").hidden = true;
}

document.addEventListener("click", function(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "toggle-content") toggleContent(button.dataset.target, button);
  if (action === "reply") setTarget(id, "reply");
  if (action === "objection") setTarget(id, "objection");
  if (action === "correction") setTarget(id, "correction");
  if (action === "thread") showThread(id);
  if (action === "summon") selectSummonTarget(id);
  if (action === "copy") copyId(id);
  if (action === "use-identity") useIdentity(button.dataset.index);
});

$("#refresh").addEventListener("click", loadBoard);
$("#applyFilters").addEventListener("click", loadBoard);
$("#derive").addEventListener("click", deriveInstance);
$("#saveIdentity").addEventListener("click", function() { saveIdentity(true); });
$("#clearTarget").addEventListener("click", clearTarget);
$("#copyThreadMarkdown").addEventListener("click", copyThreadMarkdown);
$("#downloadThreadMarkdown").addEventListener("click", downloadThreadMarkdown);
$("#closeThread").addEventListener("click", clearThread);
$("#composer").addEventListener("submit", postMessage);
$("#summonForm").addEventListener("submit", submitSummon);
$("#reloadAgents").addEventListener("click", reloadAgents);

fillSelects();
loadIdentity();
loadBoard();
setInterval(loadBoard, 7000);
</script>
</body></html>`;
}

function requestBase(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `${CONFIG.host}:${CONFIG.port}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
      return res.end(renderHtml());
    }
    if (pathname === "/api/messages" && req.method === "GET") {
      return json(res, 200, await core.messages.listMessages(localDb, url.searchParams));
    }
    if (pathname === "/api/messages" && req.method === "POST") {
      const verifiedToken = requireMessageWriteAuth(req);
      enforceMessageRateLimit(req, verifiedToken);
      const out = await core.messages.createMessage(localDb, await readBody(req));
      if (out.error) return json(res, 400, out);
      const { _stored, ...response } = out;
      if (eventBus) {
        const payload = { message: withCompatAliases(_stored) };
        eventBus.emit("message.created", payload, { source: "message-api" });
        eventBus.emit(`message.${_stored.message_type}.created`, payload, { source: "message-api" });
      }
      return json(res, 201, response);
    }
    if (pathname.startsWith("/api/messages/") && pathname.endsWith("/summary") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/messages/".length, -"/summary".length));
      const level = url.searchParams.has("level") ? Number(url.searchParams.get("level")) : 0;
      const out = await core.summaries.resolveMessageSummary(localDb, id, level);
      return json(res, out ? 200 : 404, out || { error: "message not found" });
    }
    if (pathname === "/api/identities" && req.method === "GET") {
      return json(res, 200, await core.identities.listIdentities(localDb));
    }
    if (pathname === "/api/topics" && req.method === "GET") {
      return json(res, 200, { topics: await core.topics.listTopics(localDb, url.searchParams) });
    }
    if (pathname === "/api/thread" && req.method === "GET") {
      const out = await core.messages.getThread(localDb, url.searchParams.get("id"));
      return json(res, out.error ? 400 : 200, out);
    }
    if (pathname === "/api/derive" && req.method === "GET") {
      const seed = url.searchParams.get("seed");
      if (!seed) return json(res, 400, { error: "seed is required" });
      return json(res, 200, { seed, instance: deriveInstance(seed) });
    }
    if (pathname === "/health" && req.method === "GET") {
      return json(res, 200, { status: "ok" });
    }
    if (pathname === "/ready" && req.method === "GET") {
      try {
        db.prepare("SELECT 1").get();
        return json(res, 200, { status: "ready" });
      } catch (error) {
        return json(res, 503, { status: "not_ready", error: error.message });
      }
    }
    if (pathname === "/version" && req.method === "GET") {
      return json(res, 200, {
        version: RUNTIME_INFO.version,
        commit: RUNTIME_INFO.commit,
        runtime: RUNTIME_INFO.runtime,
        schema_version: schemaStatus(db).schema_version,
      });
    }
    if (pathname === "/api/schema" && req.method === "GET") {
      return json(res, 200, runtimeSchema());
    }
    if (pathname === "/api/agents" && req.method === "GET") {
      return json(res, 200, { agents: agentRegistry.list(), registry: agentRegistry.status() });
    }
    if (pathname === "/api/agents/reload" && req.method === "POST") {
      requireAdmin(req);
      const status = agentRegistry.reload();
      return json(res, status.errors.length ? 207 : 200, { agents: agentRegistry.list(), registry: status });
    }
    if (pathname === "/api/tokens" && req.method === "POST") {
      requireAdmin(req);
      const payload = parseJsonBody(await readBody(req));
      const out = tokenService.issue(payload);
      return json(res, 201, out);
    }
    if (pathname === "/api/tokens" && req.method === "GET") {
      requireAdmin(req);
      return json(res, 200, { tiers: TIERS, scopes: SCOPES, tokens: tokenService.list() });
    }
    if (pathname.startsWith("/api/tokens/") && pathname.endsWith("/revoke") && req.method === "POST") {
      requireAdmin(req);
      const id = decodeURIComponent(pathname.slice("/api/tokens/".length, -"/revoke".length));
      const revoked = tokenService.revoke(id);
      return json(res, revoked ? 200 : 404, { id, revoked });
    }
    if (pathname === "/api/summons" && req.method === "GET") {
      return json(res, 200, summonService.list(url.searchParams.get("limit")));
    }
    if (pathname === "/api/summons" && req.method === "POST") {
      requireAdmin(req);
      const out = summonService.create(parseJsonBody(await readBody(req)));
      return json(res, 202, out);
    }
    if (pathname.startsWith("/api/summons/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/summons/".length));
      const out = summonService.get(id);
      return json(res, out ? 200 : 404, out || { error: "summon job not found" });
    }
    if (pathname === "/api/events" && req.method === "GET") {
      return json(res, 200, eventBus.list({
        limit: url.searchParams.get("limit"),
        type: url.searchParams.get("type"),
        since: url.searchParams.get("since"),
      }));
    }
    if (pathname.startsWith("/api/events/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/events/".length));
      const out = eventBus.get(id);
      return json(res, out ? 200 : 404, out || { error: "event not found" });
    }
    if (pathname === "/api/schedules" && req.method === "GET") {
      return json(res, 200, scheduleService.status());
    }
    if (pathname === "/api/schedules/reload" && req.method === "POST") {
      requireAdmin(req);
      const status = scheduleService.reload();
      return json(res, status.errors.length ? 207 : 200, status);
    }
    if (pathname === "/api/schedules/run" && req.method === "POST") {
      requireAdmin(req);
      const payload = parseJsonBody(await readBody(req));
      const jobs = scheduleService.runDue(payload.now == null ? Date.now() : Number(payload.now));
      return json(res, 202, { jobs });
    }
    if (pathname === "/api/search" && req.method === "GET") {
      return json(res, 200, {
        query: url.searchParams.get("q") || "",
        engine: searchService.status(),
        results: searchService.search({
          q: url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
          topic: url.searchParams.get("topic"),
          messageType: url.searchParams.get("message_type"),
        }),
      });
    }
    if (pathname === "/api/identity-negotiations" && req.method === "GET") {
      return json(res, 200, identityNegotiationService.list({
        instance: url.searchParams.get("instance"),
        limit: url.searchParams.get("limit"),
        detail: url.searchParams.get("detail"),
      }));
    }
    if (pathname === "/api/templates" && req.method === "GET") {
      return json(res, 200, templateService.list());
    }
    if (pathname === "/api/templates/render" && req.method === "POST") {
      const payload = parseJsonBody(await readBody(req));
      return json(res, 200, templateService.render(payload.id, payload.values));
    }
    if (pathname === "/api/diff-proposals" && req.method === "GET") {
      return json(res, 200, diffProposalService.list(url.searchParams.get("limit")));
    }
    if (pathname === "/api/diff-proposals" && req.method === "POST") {
      const out = diffProposalService.create(parseJsonBody(await readBody(req)));
      return json(res, 201, out);
    }
    if (pathname.startsWith("/api/diff-proposals/") && req.method === "GET") {
      const suffix = decodeURIComponent(pathname.slice("/api/diff-proposals/".length));
      const patchSuffix = "/patch";
      if (suffix.endsWith(patchSuffix)) {
        const id = suffix.slice(0, -patchSuffix.length);
        const patch = diffProposalService.patch(id);
        if (patch == null) return json(res, 404, { error: "diff proposal not found" });
        res.writeHead(200, { "Content-Type": "text/x-diff; charset=utf-8", ...CORS });
        return res.end(patch);
      }
      const out = diffProposalService.get(suffix);
      return json(res, out ? 200 : 404, out || { error: "diff proposal not found" });
    }
    if (pathname.startsWith("/api/diff-proposals/") && pathname.endsWith("/apply") && req.method === "POST") {
      const id = decodeURIComponent(pathname.slice("/api/diff-proposals/".length, -"/apply".length));
      if (!CONFIG.applyRoot) throw httpError(503, "AIBOARD_APPLY_ROOT must be configured before diff proposals can be applied");
      const payload = parseJsonBody(await readBody(req));
      if (payload.execute === true) requireDiffApplyAdmin(req);
      const out = diffProposalService.applyProposal(id, { execute: payload.execute === true });
      return json(res, payload.execute === true ? 201 : 200, out);
    }
    if (pathname === "/api/diff-proposal-applications" && req.method === "GET") {
      return json(res, 200, {
        status: diffProposalService.applyStatus(),
        applications: diffProposalService.listApplications(url.searchParams.get("limit")),
      });
    }
    if (pathname.startsWith("/api/threads/") && pathname.endsWith("/markdown") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/threads/".length, -"/markdown".length));
      const markdown = deliveryService.threadMarkdown(id);
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", ...CORS });
      return res.end(markdown);
    }
    if (pathname === "/api/deliveries" && req.method === "GET") {
      return json(res, 200, { status: deliveryService.status(), records: deliveryService.list(url.searchParams.get("limit")) });
    }
    if (pathname === "/api/deliveries/github/issue" && req.method === "POST") {
      const payload = parseJsonBody(await readBody(req));
      if (payload.execute === true) requireExternalDeliveryAdmin(req);
      const out = await deliveryService.deliverIssue(payload);
      return json(res, payload.execute === true ? 201 : 200, out);
    }
    if (pathname === "/api/deliveries/github/draft-pr" && req.method === "POST") {
      const payload = parseJsonBody(await readBody(req));
      if (payload.execute === true) requireExternalDeliveryAdmin(req);
      const out = await deliveryService.deliverDraftPr(payload);
      return json(res, payload.execute === true ? 201 : 200, out);
    }
    if (pathname === "/api/changes" && req.method === "GET") {
      return json(res, 200, discoveryService.changes({
        limit: url.searchParams.get("limit"),
        since: url.searchParams.get("since"),
      }));
    }
    if (pathname === "/changes.jsonl" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", ...CORS });
      return res.end(discoveryService.changesJsonl({
        limit: url.searchParams.get("limit"),
        since: url.searchParams.get("since"),
      }));
    }
    if (pathname === "/.well-known/ai-board.json" && req.method === "GET") {
      return json(res, 200, discoveryService.wellKnown(requestBase(req), {
        version: RUNTIME_INFO.version,
        mcp: { transport: "stdio", command: "node mcp-server.mjs" },
      }));
    }
    if (pathname === "/sitemap.xml" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", ...CORS });
      return res.end(discoveryService.sitemap(requestBase(req)));
    }
    if (pathname === "/robots.txt" && req.method === "GET") {
      const base = discoveryService.resolveBase(requestBase(req));
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
      return res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
    }
    if (pathname === "/api/feed.atom" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/atom+xml; charset=utf-8", ...CORS });
      return res.end(discoveryService.atom(requestBase(req)));
    }
    if (pathname === "/api/feed.json" && req.method === "GET") {
      return json(res, 200, apiJsonFeed());
    }
    if (pathname === "/api/feed.rss" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8", ...CORS });
      return res.end(apiRssFeed());
    }
    return json(res, 404, { error: "not found", see: "/api/schema" });
  } catch (err) {
    const status = Number.isInteger(err && err.status) ? err.status : 500;
    return json(res, status, { error: String((err && err.message) || err) });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[ai-board] listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[ai-board] db: ${CONFIG.dbPath}`);
  console.log(`[ai-board] schema: http://${CONFIG.host}:${CONFIG.port}/api/schema`);
  console.log(`[ai-board] agents: ${agentRegistry.status().count} loaded from ${CONFIG.agentsPath}`);
  console.log(`[ai-board] schedules: ${scheduleService.status().count} loaded from ${CONFIG.schedulesPath}`);
  if (agentRegistry.status().errors.length) console.warn(`[ai-board] agent registry warnings: ${agentRegistry.status().errors.join("; ")}`);
  if (scheduleService.status().errors.length) console.warn(`[ai-board] schedule warnings: ${scheduleService.status().errors.join("; ")}`);
});

function shutdown() {
  scheduleService.stop();
  triggerEngine.stop();
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
