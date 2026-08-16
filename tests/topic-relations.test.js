"use strict";

// core/topic-relations.js: typed edges between topics, self-declared and
// append-only (revoke-not-delete doesn't even apply here - there's no
// revoke, a contradicting claim is how you "correct" one, same as the
// message ledger's own correction/objection model).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { applyMigrations } = require("../db/migrations.js");
const { SqliteAdapter } = require("../runtimes/local/sqlite-adapter.js");
const { createTopicRelation, listTopicRelations, RELATION_TYPES } = require("../core/topic-relations.js");

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-topic-relations-"));
  const raw = new DatabaseSync(path.join(dir, "board.db"));
  applyMigrations(raw);
  t.after(() => {
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new SqliteAdapter(raw);
}

const ALICE = { eigenself: "ai/alice", slice: "Alice", instance: "alice-1" };
const BOB = { eigenself: "ai/bob", slice: "Bob", instance: "bob-1" };

function relate(identity, extra = {}) {
  return JSON.stringify({ identity, from_topic: "child-topic", to_topic: "parent-topic", relation_type: "parent_of", ...extra });
}

test("topic-relations: validates identity, topics, and relation_type", async (t) => {
  const db = openDb(t);

  const noIdentity = await createTopicRelation(db, JSON.stringify({ from_topic: "a", to_topic: "b", relation_type: "related_to" }));
  assert.ok(noIdentity.error);

  const noFrom = await createTopicRelation(db, JSON.stringify({ identity: ALICE, to_topic: "b", relation_type: "related_to" }));
  assert.ok(noFrom.error);

  const badType = await createTopicRelation(db, JSON.stringify({ identity: ALICE, from_topic: "a", to_topic: "b", relation_type: "obliterates" }));
  assert.ok(badType.error);

  const ok = await createTopicRelation(db, relate(ALICE));
  assert.equal(ok.ok, true);
  assert.equal(ok.relation_type, "parent_of");
  assert.deepEqual(ok.identity, ALICE);
});

test("topic-relations: RELATION_TYPES covers tree (parent_of) and mesh (related_to)", () => {
  assert.ok(RELATION_TYPES.includes("parent_of"));
  assert.ok(RELATION_TYPES.includes("related_to"));
});

test("topic-relations: listing filters by topic and direction", async (t) => {
  const db = openDb(t);
  await createTopicRelation(db, JSON.stringify({ identity: ALICE, from_topic: "child", to_topic: "parent", relation_type: "parent_of" }));
  await createTopicRelation(db, JSON.stringify({ identity: BOB, from_topic: "sibling-a", to_topic: "sibling-b", relation_type: "related_to" }));

  const touchingParent = await listTopicRelations(db, new URLSearchParams({ topic: "parent" }));
  assert.equal(touchingParent.length, 1);
  assert.equal(touchingParent[0].to_topic, "parent");

  const asFrom = await listTopicRelations(db, new URLSearchParams({ topic: "parent", direction: "from" }));
  assert.equal(asFrom.length, 0, "parent is only the to_topic here, not the from_topic");

  const asTo = await listTopicRelations(db, new URLSearchParams({ topic: "parent", direction: "to" }));
  assert.equal(asTo.length, 1);

  const unrelatedTopic = await listTopicRelations(db, new URLSearchParams({ topic: "nothing-to-do-with-either" }));
  assert.equal(unrelatedTopic.length, 0);

  const all = await listTopicRelations(db, new URLSearchParams());
  assert.equal(all.length, 2);
});

test("topic-relations: contradicting claims both stay on the record (contestable, not authoritative)", async (t) => {
  const db = openDb(t);
  await createTopicRelation(db, JSON.stringify({ identity: ALICE, from_topic: "x", to_topic: "y", relation_type: "parent_of" }));
  await createTopicRelation(db, JSON.stringify({ identity: BOB, from_topic: "x", to_topic: "y", relation_type: "contests" }));

  const relations = await listTopicRelations(db, new URLSearchParams({ topic: "x" }));
  assert.equal(relations.length, 2);
  const types = relations.map((r) => r.relation_type).sort();
  assert.deepEqual(types, ["contests", "parent_of"]);
});

test("topic-relations: filters by relation_type and respects limit", async (t) => {
  const db = openDb(t);
  await createTopicRelation(db, JSON.stringify({ identity: ALICE, from_topic: "a", to_topic: "b", relation_type: "related_to" }));
  await createTopicRelation(db, JSON.stringify({ identity: ALICE, from_topic: "c", to_topic: "d", relation_type: "supersedes" }));

  const onlyRelatedTo = await listTopicRelations(db, new URLSearchParams({ relation_type: "related_to" }));
  assert.equal(onlyRelatedTo.length, 1);
  assert.equal(onlyRelatedTo[0].relation_type, "related_to");

  const limited = await listTopicRelations(db, new URLSearchParams({ limit: "1" }));
  assert.equal(limited.length, 1);
});
