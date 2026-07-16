"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { EventBus, matches } = require("../events/bus.js");

test("event bus persists events and append-only handler receipts", async () => {
  const db = new DatabaseSync(":memory:");
  const bus = new EventBus({ db });
  let received = null;
  bus.on("message.*", "test-handler", async (event) => {
    received = event.payload.value;
    return { accepted: true };
  });

  const emitted = bus.emit("message.created", { value: 42 }, { source: "test" });
  await bus.waitForIdle();

  assert.equal(received, 42);
  assert.equal(matches("message.*", "message.created"), true);
  const stored = bus.get(emitted.id);
  assert.equal(stored.type, "message.created");
  assert.equal(stored.source, "test");
  assert.equal(stored.receipts.length, 1);
  assert.equal(stored.receipts[0].status, "completed");
  assert.throws(() => db.prepare("DELETE FROM board_events WHERE id = ?").run(emitted.id), /append-only/);
  db.close();
});
