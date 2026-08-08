"use strict";

// Human master switch (docs/AI_Board_持續Agent身分與多入口架構...§6.1, §11
// item 6): meta.authorship.autonomous_post posts must be rejectable by an
// admin-set flag, while human-triggered/human-approved agent posts must
// never be affected by it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { applyMigrations } = require("../db/migrations.js");
const { SqliteAdapter } = require("../runtimes/local/sqlite-adapter.js");
const { createMessage } = require("../core/messages.js");
const {
  isAutonomousPostingPaused,
  pauseAutonomousPosting,
  resumeAutonomousPosting,
  autonomousPostingStatus,
} = require("../core/system-flags.js");

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-system-flags-"));
  const raw = new DatabaseSync(path.join(dir, "board.db"));
  applyMigrations(raw);
  t.after(() => {
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new SqliteAdapter(raw);
}

const IDENTITY = { eigenself: "evemisslab/board-host", slice: "Test Host", instance: "flag-test-1" };

function autonomousPost(extra = {}) {
  return JSON.stringify({
    identity: IDENTITY,
    content: "an autonomous post",
    meta: { authorship: { agent_generated: true, autonomous_post: true }, ...extra },
  });
}

test("system-flags: default state is unpaused", async (t) => {
  const db = openDb(t);
  assert.equal(await isAutonomousPostingPaused(db), false);
  const status = await autonomousPostingStatus(db);
  assert.equal(status.paused, false);
  assert.equal(status.updated_at, null);
});

test("system-flags: pause/resume round-trips and updates status", async (t) => {
  const db = openDb(t);
  const paused = await pauseAutonomousPosting(db, "test-admin");
  assert.equal(paused.value, "true");
  assert.equal(await isAutonomousPostingPaused(db), true);

  const status = await autonomousPostingStatus(db);
  assert.equal(status.paused, true);
  assert.equal(status.updated_by, "test-admin");
  assert.ok(status.updated_at > 0);

  await resumeAutonomousPosting(db, "test-admin");
  assert.equal(await isAutonomousPostingPaused(db), false);
});

test("createMessage: rejects an autonomous_post while paused", async (t) => {
  const db = openDb(t);
  await pauseAutonomousPosting(db, "test-admin");

  const out = await createMessage(db, autonomousPost());
  assert.equal(out.ok, undefined);
  assert.equal(out.code, "AUTONOMOUS_POSTING_PAUSED");
});

test("createMessage: an autonomous_post succeeds once resumed", async (t) => {
  const db = openDb(t);
  await pauseAutonomousPosting(db, "test-admin");
  await resumeAutonomousPosting(db, "test-admin");

  const out = await createMessage(db, autonomousPost());
  assert.equal(out.ok, true);
});

test("createMessage: a human-triggered post is never blocked by the pause", async (t) => {
  const db = openDb(t);
  await pauseAutonomousPosting(db, "test-admin");

  const humanTriggered = JSON.stringify({
    identity: IDENTITY,
    content: "a human asked for this",
    meta: { authorship: { human_requested: true, autonomous_post: false } },
  });
  const out = await createMessage(db, humanTriggered);
  assert.equal(out.ok, true);
});

test("createMessage: a post with no authorship metadata at all is never blocked by the pause", async (t) => {
  const db = openDb(t);
  await pauseAutonomousPosting(db, "test-admin");

  const out = await createMessage(db, JSON.stringify({ identity: IDENTITY, content: "plain post, no meta" }));
  assert.equal(out.ok, true);
});
