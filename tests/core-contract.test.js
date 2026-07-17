"use strict";

// Contract tests for core/ - exercised directly against the local SQLite
// adapter, with no HTTP server and no child process. The same test bodies
// are meant to run unmodified against a Cloudflare D1 adapter once that
// exists, proving "same payload -> same result" across runtimes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { applyMigrations } = require("../db/migrations.js");
const { SqliteAdapter } = require("../runtimes/local/sqlite-adapter.js");
const { createMessage, listMessages, getThread } = require("../core/messages.js");
const { listTopics } = require("../core/topics.js");
const { listIdentities } = require("../core/identities.js");
const { resolveMessageSummary } = require("../core/summaries.js");

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-core-contract-"));
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

test("core/messages: createMessage, listMessages, getThread", async (t) => {
  const db = openDb(t);
  const identity = { eigenself: "human/test", slice: "Contract", instance: "contract-1" };

  const invalid = await createMessage(db, JSON.stringify({ identity }));
  assert.ok(invalid.error, "content-less payload should be rejected");

  const root = await createMessage(db, post(identity, { topic: "core-test", content: "root claim" }));
  assert.equal(root.ok, true);
  assert.equal(root.topic, "core-test");
  assert.equal(root.paper_ref, "core-test");
  assert.equal(root._stored.content, "root claim");

  const reply = await createMessage(db, post(
    { eigenself: "ai/reviewer", slice: "Reviewer", instance: "reviewer-1" },
    { topic: "core-test", message_type: "objection", parent_id: root.id, content: "root claim needs qualification" }
  ));
  assert.equal(reply.ok, true);

  const listed = await listMessages(db, new URLSearchParams({ topic: "core-test" }));
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, reply.id, "newest first");

  const filteredByType = await listMessages(db, new URLSearchParams({ topic: "core-test", message_type: "objection" }));
  assert.equal(filteredByType.length, 1);
  assert.equal(filteredByType[0].id, reply.id);

  const thread = await getThread(db, root.id);
  assert.equal(thread.id, root.id);
  assert.equal(thread.children.length, 1);
  assert.equal(thread.children[0].id, reply.id);

  const missing = await getThread(db, "does-not-exist");
  assert.equal(missing.error, "not found");
});

test("core/topics: listTopics aggregates message and participant counts", async (t) => {
  const db = openDb(t);
  await createMessage(db, post({ eigenself: "human/test", slice: "A", instance: "a-1" }, { topic: "agg-test", content: "one" }));
  await createMessage(db, post({ eigenself: "ai/other", slice: "B", instance: "b-1" }, { topic: "agg-test", content: "two" }));
  await createMessage(db, post({ eigenself: "human/test", slice: "A", instance: "a-1" }, { topic: "other-topic", content: "three" }));

  const topics = await listTopics(db, new URLSearchParams());
  const aggTest = topics.find((row) => row.topic === "agg-test");
  assert.ok(aggTest);
  assert.equal(aggTest.message_count, 2);
  assert.equal(aggTest.participant_count, 2);
});

test("core/identities: listIdentities counts posts and objections per identity", async (t) => {
  const db = openDb(t);
  const identity = { eigenself: "human/test", slice: "Claimant", instance: "claimant-1" };
  const root = await createMessage(db, post(identity, { topic: "identity-test", content: "a claim" }));
  await createMessage(db, post(
    { eigenself: "ai/reviewer", slice: "Reviewer", instance: "reviewer-2" },
    { topic: "identity-test", message_type: "objection", parent_id: root.id, content: "disputed" }
  ));

  const identities = await listIdentities(db);
  const claimant = identities.find((row) => row.instance === "claimant-1");
  assert.ok(claimant);
  assert.equal(claimant.posts, 1);
  assert.equal(claimant.objections, 1);
});

test("core/summaries: resolveMessageSummary drills down and falls back to full content", async (t) => {
  const db = openDb(t);
  const identity = { eigenself: "human/test", slice: "Tiered", instance: "tiered-core-1" };
  const created = await createMessage(db, post(identity, {
    topic: "summary-test",
    content: "The full, long-form account with every supporting detail.",
    summary_levels: ["Gist.", "Gist with one supporting reason."],
  }));
  assert.equal(created.ok, true);

  const level0 = await resolveMessageSummary(db, created.id, 0);
  assert.equal(level0.content, "Gist.");
  assert.equal(level0.max_level, 2);
  assert.equal(level0.has_more, true);

  const level1 = await resolveMessageSummary(db, created.id, 1);
  assert.equal(level1.content, "Gist with one supporting reason.");

  const fullLevel = await resolveMessageSummary(db, created.id, 99);
  assert.equal(fullLevel.is_full, true);
  assert.match(fullLevel.content, /full, long-form account/);

  const untiered = await createMessage(db, post(identity, { topic: "summary-test", content: "no tiers here" }));
  const untieredSummary = await resolveMessageSummary(db, untiered.id, 0);
  assert.equal(untieredSummary.max_level, 0);
  assert.equal(untieredSummary.is_full, true);

  const missing = await resolveMessageSummary(db, "does-not-exist", 0);
  assert.equal(missing, null);
});
