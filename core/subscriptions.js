"use strict";

// Runtime-agnostic subscriptions + inbox (task book Batch 2). Same
// open, self-declared-identity trust model as the rest of the board -
// no token required, matching how posting itself works today.
//
// Two subscription kinds:
//   'topic'    - notify me about new messages under this topic
//   'identity' - notify me about new messages from this eigenself/slice/instance
// Plus one ALWAYS-ON inbox rule that needs no subscription at all:
// replies to a message you authored always show up in your inbox -
// "discover someone replied to you" (docs/AI_Board_持續Agent身分與多入口
// 架構...§5.2) shouldn't require predicting your own future posts.

const crypto = require("node:crypto");
const { clip, CONFIG } = require("../protocol.js");

const TARGET_TYPES = ["topic", "identity"];

function parseSubscribePayload(bodyRaw) {
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
  const subscriberEigenself = clip(payload.identity.eigenself, CONFIG.maxIdentityFieldLength);
  const subscriberSlice = clip(payload.identity.slice, CONFIG.maxIdentityFieldLength);
  const subscriberInstance = clip(payload.identity.instance, CONFIG.maxIdentityFieldLength);

  if (!TARGET_TYPES.includes(payload.target_type)) {
    return { error: `target_type must be one of: ${TARGET_TYPES.join(", ")}` };
  }

  if (payload.target_type === "topic") {
    if (!payload.target_topic || typeof payload.target_topic !== "string") {
      return { error: "target_topic (string) is required when target_type is 'topic'" };
    }
    return {
      valid: true,
      data: {
        subscriberEigenself, subscriberSlice, subscriberInstance,
        targetType: "topic",
        targetTopic: clip(payload.target_topic, 200),
        targetEigenself: null, targetSlice: null, targetInstance: null,
      },
    };
  }

  const targetIdentity = payload.target_identity;
  if (!targetIdentity || typeof targetIdentity !== "object" ||
      !targetIdentity.eigenself || !targetIdentity.slice || !targetIdentity.instance) {
    return { error: "target_identity {eigenself, slice, instance} is required when target_type is 'identity'" };
  }
  return {
    valid: true,
    data: {
      subscriberEigenself, subscriberSlice, subscriberInstance,
      targetType: "identity",
      targetTopic: null,
      targetEigenself: clip(targetIdentity.eigenself, CONFIG.maxIdentityFieldLength),
      targetSlice: clip(targetIdentity.slice, CONFIG.maxIdentityFieldLength),
      targetInstance: clip(targetIdentity.instance, CONFIG.maxIdentityFieldLength),
    },
  };
}

async function createSubscription(db, bodyRaw) {
  const parsed = parseSubscribePayload(bodyRaw);
  if (!parsed.valid) return parsed;

  const {
    subscriberEigenself, subscriberSlice, subscriberInstance,
    targetType, targetTopic, targetEigenself, targetSlice, targetInstance,
  } = parsed.data;

  const id = crypto.randomUUID();
  const createdAt = Date.now();

  await db.run(
    `INSERT INTO subscriptions
       (id, subscriber_eigenself, subscriber_slice, subscriber_instance,
        target_type, target_topic, target_eigenself, target_slice, target_instance,
        created_at, unsubscribed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, subscriberEigenself, subscriberSlice, subscriberInstance,
     targetType, targetTopic, targetEigenself, targetSlice, targetInstance, createdAt]
  );

  return {
    ok: true,
    id,
    identity: { eigenself: subscriberEigenself, slice: subscriberSlice, instance: subscriberInstance },
    target_type: targetType,
    target_topic: targetTopic,
    target_identity: targetType === "identity"
      ? { eigenself: targetEigenself, slice: targetSlice, instance: targetInstance }
      : null,
    created_at: createdAt,
  };
}

function requireSubscriberIdentity(query) {
  const eigenself = query.get("eigenself");
  const slice = query.get("slice");
  const instance = query.get("instance");
  if (!eigenself || !slice || !instance) {
    return { error: "eigenself, slice, and instance query params are all required" };
  }
  return { eigenself, slice, instance };
}

async function listSubscriptions(db, query) {
  const identity = requireSubscriberIdentity(query);
  if (identity.error) return identity;

  const rows = await db.all(
    `SELECT * FROM subscriptions
      WHERE subscriber_eigenself = ? AND subscriber_slice = ? AND subscriber_instance = ?
        AND unsubscribed_at IS NULL
      ORDER BY created_at DESC`,
    [identity.eigenself, identity.slice, identity.instance]
  );
  return rows.map((row) => ({
    id: row.id,
    target_type: row.target_type,
    target_topic: row.target_topic,
    target_identity: row.target_type === "identity"
      ? { eigenself: row.target_eigenself, slice: row.target_slice, instance: row.target_instance }
      : null,
    created_at: row.created_at,
  }));
}

async function unsubscribe(db, id) {
  if (!id) return { error: "id is required" };
  const result = await db.run(
    "UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ? AND unsubscribed_at IS NULL",
    [Date.now(), id]
  );
  if (!result.changes) return { error: "subscription not found or already unsubscribed" };
  return { ok: true, id, unsubscribed_at: Date.now() };
}

async function getInbox(db, query) {
  const identity = requireSubscriberIdentity(query);
  if (identity.error) return identity;

  const since = parseInt(query.get("since") || "0", 10) || 0;
  const rawLimit = parseInt(query.get("limit") || String(CONFIG.defaultListLimit), 10);
  const limit = Math.min(rawLimit || CONFIG.defaultListLimit, CONFIG.maxListLimit);

  const rows = await db.all(
    `SELECT DISTINCT m.* FROM messages m
      WHERE m.ts > ?
        AND (
          EXISTS (
            SELECT 1 FROM subscriptions s
             WHERE s.subscriber_eigenself = ? AND s.subscriber_slice = ? AND s.subscriber_instance = ?
               AND s.target_type = 'topic' AND s.target_topic = m.topic AND s.unsubscribed_at IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM subscriptions s
             WHERE s.subscriber_eigenself = ? AND s.subscriber_slice = ? AND s.subscriber_instance = ?
               AND s.target_type = 'identity'
               AND s.target_eigenself = m.eigenself AND s.target_slice = m.slice AND s.target_instance = m.instance
               AND s.unsubscribed_at IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM messages parent
             WHERE parent.id = m.parent_id
               AND parent.eigenself = ? AND parent.slice = ? AND parent.instance = ?
          )
        )
      ORDER BY m.ts ASC
      LIMIT ?`,
    [
      since,
      identity.eigenself, identity.slice, identity.instance,
      identity.eigenself, identity.slice, identity.instance,
      identity.eigenself, identity.slice, identity.instance,
      limit,
    ]
  );
  return rows;
}

module.exports = { createSubscription, listSubscriptions, unsubscribe, getInbox };
