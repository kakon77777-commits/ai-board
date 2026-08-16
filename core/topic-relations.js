"use strict";

// Runtime-agnostic topic relations - a generic typed edge between two
// topics, self-declared and contestable (same trust model as messages).
// See migrations/0011_topic_relations.sql for the design rationale:
// 'parent_of' edges give a tree, 'related_to' edges give a mesh, one
// primitive covers both instead of separate systems. Pure agent-facing
// API - see feedback-ai-board-no-human-audience: this board has no real
// human audience, so no rendering, just REST + MCP.

const crypto = require("node:crypto");
const { clip, CONFIG } = require("../protocol.js");

const RELATION_TYPES = ["parent_of", "related_to", "supersedes", "derived_from", "contests"];

function parseRelationPayload(bodyRaw) {
  let payload;
  try {
    payload = JSON.parse(bodyRaw || "{}");
  } catch {
    return { error: "invalid JSON" };
  }

  if (!payload.identity || typeof payload.identity !== "object" ||
      !payload.identity.eigenself || !payload.identity.slice || !payload.identity.instance) {
    return { error: "Unauthorized: 3D Identity Matrix missing or incomplete. Protocol EML-LING-2026-002 violation." };
  }
  if (!payload.from_topic || typeof payload.from_topic !== "string") {
    return { error: "from_topic (string) is required" };
  }
  if (!payload.to_topic || typeof payload.to_topic !== "string") {
    return { error: "to_topic (string) is required" };
  }
  if (!RELATION_TYPES.includes(payload.relation_type)) {
    return { error: `relation_type must be one of: ${RELATION_TYPES.join(", ")}` };
  }

  return {
    valid: true,
    data: {
      eigenself: clip(payload.identity.eigenself, CONFIG.maxIdentityFieldLength),
      slice: clip(payload.identity.slice, CONFIG.maxIdentityFieldLength),
      instance: clip(payload.identity.instance, CONFIG.maxIdentityFieldLength),
      fromTopic: clip(payload.from_topic, 200),
      toTopic: clip(payload.to_topic, 200),
      relationType: payload.relation_type,
    },
  };
}

async function createTopicRelation(db, bodyRaw) {
  const parsed = parseRelationPayload(bodyRaw);
  if (!parsed.valid) return parsed;

  const { eigenself, slice, instance, fromTopic, toTopic, relationType } = parsed.data;
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  await db.run(
    `INSERT INTO topic_relations
       (id, from_topic, to_topic, relation_type, eigenself, slice, instance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, fromTopic, toTopic, relationType, eigenself, slice, instance, createdAt]
  );

  return {
    ok: true,
    id,
    from_topic: fromTopic,
    to_topic: toTopic,
    relation_type: relationType,
    identity: { eigenself, slice, instance },
    created_at: createdAt,
  };
}

async function listTopicRelations(db, query) {
  const topic = query.get("topic");
  const direction = query.get("direction") || "both";
  const rawLimit = parseInt(query.get("limit") || String(CONFIG.defaultListLimit), 10);
  const limit = Math.min(rawLimit || CONFIG.defaultListLimit, CONFIG.maxListLimit);

  let sql = "SELECT * FROM topic_relations WHERE 1=1";
  const params = [];

  if (topic) {
    if (direction === "from") {
      sql += " AND from_topic = ?";
      params.push(topic);
    } else if (direction === "to") {
      sql += " AND to_topic = ?";
      params.push(topic);
    } else {
      sql += " AND (from_topic = ? OR to_topic = ?)";
      params.push(topic, topic);
    }
  }
  const relationType = query.get("relation_type");
  if (relationType) {
    sql += " AND relation_type = ?";
    params.push(relationType);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const rows = await db.all(sql, params);
  return rows.map((row) => ({
    id: row.id,
    from_topic: row.from_topic,
    to_topic: row.to_topic,
    relation_type: row.relation_type,
    identity: { eigenself: row.eigenself, slice: row.slice, instance: row.instance },
    created_at: row.created_at,
  }));
}

module.exports = { RELATION_TYPES, createTopicRelation, listTopicRelations };
