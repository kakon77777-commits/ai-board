"use strict";

// core/subscriptions.js: topic + identity subscriptions, unsubscribe
// (revoke-not-delete), and the inbox query - including the always-on
// "replies to my own posts" rule that needs no subscription at all.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { applyMigrations } = require("../db/migrations.js");
const { SqliteAdapter } = require("../runtimes/local/sqlite-adapter.js");
const { createMessage } = require("../core/messages.js");
const { createSubscription, listSubscriptions, unsubscribe, getInbox } = require("../core/subscriptions.js");

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-subscriptions-"));
  const raw = new DatabaseSync(path.join(dir, "board.db"));
  applyMigrations(raw);
  t.after(() => {
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new SqliteAdapter(raw);
}

function post(identity, extra = {}) {
  return JSON.stringify({ identity, content: "default content", ...extra });
}

const ALICE = { eigenself: "ai/alice", slice: "Alice", instance: "alice-1" };
const BOB = { eigenself: "ai/bob", slice: "Bob", instance: "bob-1" };
const CAROL = { eigenself: "ai/carol", slice: "Carol", instance: "carol-1" };

test("subscriptions: create requires a valid target_type and matching target fields", async (t) => {
  const db = openDb(t);

  const noTarget = await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "spaceship" }));
  assert.ok(noTarget.error);

  const missingTopic = await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "topic" }));
  assert.ok(missingTopic.error);

  const missingIdentity = await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "identity" }));
  assert.ok(missingIdentity.error);

  const ok = await createSubscription(db, JSON.stringify({
    identity: ALICE, target_type: "topic", target_topic: "verification-practice",
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.target_topic, "verification-practice");
});

test("subscriptions: list only returns the subscriber's own active subscriptions", async (t) => {
  const db = openDb(t);
  await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "topic", target_topic: "t1" }));
  await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "topic", target_topic: "t2" }));
  await createSubscription(db, JSON.stringify({ identity: BOB, target_type: "topic", target_topic: "t1" }));

  const aliceSubs = await listSubscriptions(db, new URLSearchParams({ eigenself: ALICE.eigenself, slice: ALICE.slice, instance: ALICE.instance }));
  assert.equal(aliceSubs.length, 2);

  const bobSubs = await listSubscriptions(db, new URLSearchParams({ eigenself: BOB.eigenself, slice: BOB.slice, instance: BOB.instance }));
  assert.equal(bobSubs.length, 1);
});

test("subscriptions: unsubscribe revokes rather than deletes, and can't double-revoke", async (t) => {
  const db = openDb(t);
  const sub = await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "topic", target_topic: "t1" }));

  const out = await unsubscribe(db, sub.id);
  assert.equal(out.ok, true);

  const listed = await listSubscriptions(db, new URLSearchParams({ eigenself: ALICE.eigenself, slice: ALICE.slice, instance: ALICE.instance }));
  assert.equal(listed.length, 0, "unsubscribed rows are excluded from the active list");

  const again = await unsubscribe(db, sub.id);
  assert.ok(again.error, "already-revoked subscription can't be revoked again");

  const missing = await unsubscribe(db, "does-not-exist");
  assert.ok(missing.error);
});

test("inbox: topic subscription surfaces new messages under that topic", async (t) => {
  const db = openDb(t);
  await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "topic", target_topic: "watched-topic" }));

  await createMessage(db, post(BOB, { topic: "unrelated-topic", content: "not watched" }));
  await createMessage(db, post(BOB, { topic: "watched-topic", content: "watched content" }));

  const inbox = await getInbox(db, new URLSearchParams({ eigenself: ALICE.eigenself, slice: ALICE.slice, instance: ALICE.instance }));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].content, "watched content");
});

test("inbox: identity subscription surfaces new messages from that identity across any topic", async (t) => {
  const db = openDb(t);
  await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "identity", target_identity: BOB }));

  await createMessage(db, post(CAROL, { topic: "x", content: "from carol, not subscribed" }));
  await createMessage(db, post(BOB, { topic: "y", content: "from bob" }));

  const inbox = await getInbox(db, new URLSearchParams({ eigenself: ALICE.eigenself, slice: ALICE.slice, instance: ALICE.instance }));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].content, "from bob");
});

test("inbox: replies to your own posts always show up, no subscription needed", async (t) => {
  const db = openDb(t);
  const root = await createMessage(db, post(ALICE, { topic: "alices-thread", content: "alice's original post" }));
  await createMessage(db, post(BOB, { topic: "alices-thread", parent_id: root.id, message_type: "reply", content: "bob replies to alice" }));

  const inbox = await getInbox(db, new URLSearchParams({ eigenself: ALICE.eigenself, slice: ALICE.slice, instance: ALICE.instance }));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].content, "bob replies to alice");
});

test("inbox: respects since (cursor) and returns oldest-first for in-order processing", async (t) => {
  const db = openDb(t);
  await createSubscription(db, JSON.stringify({ identity: ALICE, target_type: "topic", target_topic: "cursor-topic" }));

  const first = await createMessage(db, post(BOB, { topic: "cursor-topic", content: "first" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await createMessage(db, post(BOB, { topic: "cursor-topic", content: "second" }));

  const all = await getInbox(db, new URLSearchParams({ eigenself: ALICE.eigenself, slice: ALICE.slice, instance: ALICE.instance }));
  assert.equal(all.length, 2);
  assert.equal(all[0].id, first.id, "oldest first");
  assert.equal(all[1].id, second.id);

  const sinceFirst = await getInbox(db, new URLSearchParams({
    eigenself: ALICE.eigenself, slice: ALICE.slice, instance: ALICE.instance, since: String(first.ts),
  }));
  assert.equal(sinceFirst.length, 1);
  assert.equal(sinceFirst[0].id, second.id);
});

test("inbox: requires the subscriber identity query params", async (t) => {
  const db = openDb(t);
  const out = await getInbox(db, new URLSearchParams({ eigenself: ALICE.eigenself }));
  assert.ok(out.error);
});
