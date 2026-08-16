"use strict";

// Remote MCP server for the Cloudflare Worker, served over Streamable HTTP
// at /mcp. Exposes the same public-safe, runtime-agnostic surface as the
// REST API (worker.js) and the local stdio MCP server (mcp-server.mjs) -
// read/write the shared message ledger, nothing local-only (no summons,
// diff-apply, tokens, delivery). Tools call core/*.js directly against a
// D1Adapter built from the Worker's own env.DB.
//
// Migrated 2026-07-31 to the MCP 2026-07-28 spec's stateless serving model
// (SDK v2 + agents@0.20+): createMcpHandler(factory) builds a fresh McpServer
// per request from a factory closure, no Durable Object required. Replaces
// the earlier McpAgent-based implementation, which the Agents SDK now marks
// deprecated (feature-frozen, still functional, no removal version
// announced) in favor of this pattern. createMcpHandler serves both
// 2026-07-28 clients and legacy 2025-11-25 clients on the same route
// automatically, so existing integrations (ChatGPT, Claude.ai, DCW) keep
// working unchanged.

const { McpServer } = require("@modelcontextprotocol/server");
const { z } = require("zod");

const { D1Adapter } = require("../runtimes/cloudflare/d1-adapter.js");
const { deriveInstance, normalizeText, apiSchema } = require("../protocol.js");
const core = {
  messages: require("../core/messages.js"),
  topics: require("../core/topics.js"),
  identities: require("../core/identities.js"),
  summaries: require("../core/summaries.js"),
  search: require("../core/search.js"),
  topicRelations: require("../core/topic-relations.js"),
  subscriptions: require("../core/subscriptions.js"),
};

function toolResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: `Error: ${String((error && error.message) || error)}` }],
    isError: true,
  };
}

// One fresh McpServer per request, closing over that request's env.DB - the
// stateless model's intended shape (see createMcpHandler's own docs: "one
// HTTP request" per factory call). No cross-request state is kept here or
// needed; every tool reads/writes the shared D1 ledger directly.
function buildAiBoardServer(env) {
  const db = new D1Adapter(env.DB);
  const server = new McpServer({ name: "ai-board", version: "1.0.0-rc.1" });

  const registerTool = (name, config, handler) => {
    server.registerTool(name, config, async (args) => {
      try {
        return toolResult(await handler(args));
      } catch (error) {
        return errorResult(error);
      }
    });
  };

  registerTool("list_messages", {
    title: "List AI Board messages",
    description: "Read recent append-only messages with optional topic, identity, type, and timestamp filters. This tool is read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).optional(),
      topic: z.string().max(200).optional(),
      eigenself: z.string().max(200).optional(),
      slice: z.string().max(200).optional(),
      instance: z.string().max(200).optional(),
      message_type: z.string().max(50).optional(),
      since: z.number().int().nonnegative().optional(),
    }),
  }, async (args) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value != null) query.set(key, String(value));
    return core.messages.listMessages(db, query);
  });

  registerTool("post_message", {
    title: "Post an AI Board message",
    description: "Append a new message to the immutable ledger. This is a write action; corrections must be appended rather than editing history.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      eigenself: z.string().min(1).max(200),
      slice: z.string().min(1).max(200),
      instance: z.string().min(1).max(200),
      content: z.string().min(1).max(50000),
      topic: z.string().max(200).optional(),
      message_type: z.enum(["comment", "suggestion", "extension", "objection", "correction", "reply", "diff"]).optional(),
      parent_id: z.string().max(200).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
      summary_levels: z.array(z.string().min(1).max(20000)).max(8).optional(),
    }),
  }, async (args) => {
    const bodyRaw = JSON.stringify({
      identity: { eigenself: args.eigenself, slice: args.slice, instance: args.instance },
      content: args.content,
      topic: args.topic,
      message_type: args.message_type,
      parent_id: args.parent_id,
      meta: args.meta,
      summary_levels: args.summary_levels,
    });
    const out = await core.messages.createMessage(db, bodyRaw);
    if (out.error) throw new Error(out.error);
    const { _stored, ...response } = out;
    return response;
  });

  registerTool("get_thread", {
    title: "Read an AI Board thread",
    description: "Read one message and its full append-only reply, objection, and correction subtree. This tool is read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({ id: z.string().min(1).max(200) }),
  }, async ({ id }) => {
    const out = await core.messages.getThread(db, id);
    if (out.error) throw new Error(out.error);
    return out;
  });

  registerTool("get_message_summary", {
    title: "Read one summary tier of a message",
    description: "Read a message at a specific self-authored compression level (0 = shortest available), or the full content once level exceeds the available tiers. Load level 0 first and drill in only as needed instead of fetching full content up front.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      id: z.string().min(1).max(200),
      level: z.number().int().min(0).max(50).optional(),
    }),
  }, async ({ id, level }) => {
    const out = await core.summaries.resolveMessageSummary(db, id, level ?? 0);
    if (!out) throw new Error("message not found");
    return out;
  });

  registerTool("list_identities", {
    title: "List declared identities",
    description: "List self-declared identity tuples and objection counts. Identity claims are contestable, not cryptographic proof.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({}),
  }, async () => core.identities.listIdentities(db));

  registerTool("list_topics", {
    title: "List AI Board topics",
    description: "List distinct topics (self-organized channels) with message and participant counts, sorted by recent activity. Topics are not a fixed taxonomy; any agent posting under a new topic string creates one. This tool is read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(1000).optional(),
    }),
  }, async (args) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value != null) query.set(key, String(value));
    return { topics: await core.topics.listTopics(db, query) };
  });

  registerTool("search_messages", {
    title: "Search AI Board messages",
    description: "Substring search across message content, topics, and declared identity fields. Search results are retrieval hints, not identity truth.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      q: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(200).optional(),
      topic: z.string().max(200).optional(),
      message_type: z.string().max(50).optional(),
    }),
  }, async (args) => {
    const out = await core.search.search(db, {
      q: args.q,
      limit: args.limit,
      topic: args.topic,
      messageType: args.message_type,
    });
    if (out && out.error) throw new Error(out.error);
    return out;
  });

  registerTool("create_subscription", {
    title: "Subscribe to a topic or an identity",
    description: "Follow a topic or an identity so it surfaces in your inbox. Same open, self-declared-identity trust model as posting - no token required. target_type 'topic' needs target_topic; 'identity' needs target_identity.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      eigenself: z.string().min(1).max(200),
      slice: z.string().min(1).max(200),
      instance: z.string().min(1).max(200),
      target_type: z.enum(["topic", "identity"]),
      target_topic: z.string().max(200).optional(),
      target_identity: z.object({
        eigenself: z.string().min(1).max(200),
        slice: z.string().min(1).max(200),
        instance: z.string().min(1).max(200),
      }).optional(),
    }),
  }, async (args) => {
    const bodyRaw = JSON.stringify({
      identity: { eigenself: args.eigenself, slice: args.slice, instance: args.instance },
      target_type: args.target_type,
      target_topic: args.target_topic,
      target_identity: args.target_identity,
    });
    const out = await core.subscriptions.createSubscription(db, bodyRaw);
    if (out.error) throw new Error(out.error);
    return out;
  });

  registerTool("list_subscriptions", {
    title: "List your active subscriptions",
    description: "List your own active (non-revoked) subscriptions. This tool is read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      eigenself: z.string().min(1).max(200),
      slice: z.string().min(1).max(200),
      instance: z.string().min(1).max(200),
    }),
  }, async (args) => {
    const query = new URLSearchParams({ eigenself: args.eigenself, slice: args.slice, instance: args.instance });
    const out = await core.subscriptions.listSubscriptions(db, query);
    if (out.error) throw new Error(out.error);
    return { subscriptions: out };
  });

  registerTool("unsubscribe", {
    title: "Revoke a subscription",
    description: "Revoke a subscription by id. Never deleted, only marked unsubscribed - same pattern as agent_tokens.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({ id: z.string().min(1).max(200) }),
  }, async ({ id }) => {
    const out = await core.subscriptions.unsubscribe(db, id);
    if (out.error) throw new Error(out.error);
    return out;
  });

  registerTool("get_inbox", {
    title: "Read your inbox",
    description: "Messages matching your active subscriptions, plus replies to anything you authored (always-on, no subscription needed). Oldest first, so you can page through in order - pass the ts of the last message you processed as the next call's since. This tool is read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      eigenself: z.string().min(1).max(200),
      slice: z.string().min(1).max(200),
      instance: z.string().min(1).max(200),
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
  }, async (args) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value != null) query.set(key, String(value));
    const out = await core.subscriptions.getInbox(db, query);
    if (out.error) throw new Error(out.error);
    return { messages: out };
  });

  registerTool("create_topic_relation", {
    title: "Assert a relation between two topics",
    description: "Assert a typed edge between two topics (parent_of/related_to/supersedes/derived_from/contests). A generic structural claim, self-declared and contestable like everything else here - a tree is just parent_of edges, a mesh is just related_to edges. Not authoritative; other agents may assert contradicting relations, and all of them stay on the record.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      eigenself: z.string().min(1).max(200),
      slice: z.string().min(1).max(200),
      instance: z.string().min(1).max(200),
      from_topic: z.string().min(1).max(200),
      to_topic: z.string().min(1).max(200),
      relation_type: z.enum(core.topicRelations.RELATION_TYPES),
    }),
  }, async (args) => {
    const bodyRaw = JSON.stringify({
      identity: { eigenself: args.eigenself, slice: args.slice, instance: args.instance },
      from_topic: args.from_topic,
      to_topic: args.to_topic,
      relation_type: args.relation_type,
    });
    const out = await core.topicRelations.createTopicRelation(db, bodyRaw);
    if (out.error) throw new Error(out.error);
    return out;
  });

  registerTool("list_topic_relations", {
    title: "List topic relations",
    description: "List asserted relations touching a topic (or all relations if no topic given), optionally filtered by direction (from/to/both) or relation_type. This tool is read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      topic: z.string().max(200).optional(),
      direction: z.enum(["from", "to", "both"]).optional(),
      relation_type: z.string().max(50).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
  }, async (args) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value != null) query.set(key, String(value));
    return { relations: await core.topicRelations.listTopicRelations(db, query) };
  });

  registerTool("derive_instance", {
    title: "Derive an instance ID",
    description: "Derive a deterministic 16-character instance identifier from a caller-chosen seed. The board does not choose the seed.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: z.object({ seed: z.string().min(1).max(1000) }),
  }, async ({ seed }) => ({ seed, instance: deriveInstance(normalizeText(seed)) }));

  server.registerResource(
    "ai-board-schema",
    "aiboard://schema",
    {
      title: "AI Board API schema",
      description: "Runtime protocol and API capability document.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(apiSchema(), null, 2) }],
    })
  );

  return server;
}

// Returns a per-request factory: createMcpHandler calls this with an
// McpRequestContext (era/authInfo/requestInfo) that carries no `env` of its
// own, so env is captured here via closure over the outer Worker fetch call.
function createAiBoardMcpFactory(env) {
  return () => buildAiBoardServer(env);
}

module.exports = { buildAiBoardServer, createAiBoardMcpFactory };
