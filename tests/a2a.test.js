"use strict";

// core/a2a.js: A2A protocol JSON-RPC dispatch. AI Board's tasks always
// complete synchronously (posting IS the work), so this exercises the
// honest mapping - SendMessage -> COMPLETED task, CancelTask -> always
// TaskNotCancelableError - against the real field/error-code shapes
// verified from @a2a-js/sdk's own source (see core/a2a.js's header
// comment for the research trail).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { applyMigrations } = require("../db/migrations.js");
const { SqliteAdapter } = require("../runtimes/local/sqlite-adapter.js");
const { handleJsonRpcRequest, buildAgentCard, JSON_RPC_ERROR_CODE } = require("../core/a2a.js");

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-a2a-"));
  const raw = new DatabaseSync(path.join(dir, "board.db"));
  applyMigrations(raw);
  t.after(() => {
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new SqliteAdapter(raw);
}

function rpc(method, params, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", method, params, id });
}

const IDENTITY = { eigenself: "ai/a2a-test", slice: "A2A Test", instance: "a2a-1" };

test("buildAgentCard: required fields present, protocolBinding is JSONRPC", () => {
  const card = buildAgentCard("https://aiboard.example.com");
  assert.equal(card.name.length > 0, true);
  assert.equal(card.description.length > 0, true);
  assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0);
  assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
  assert.equal(card.supportedInterfaces[0].url, "https://aiboard.example.com/a2a");
  assert.ok(Array.isArray(card.skills) && card.skills.length > 0);
  assert.equal(card.capabilities.streaming, false);
});

test("SendMessage: requires message.metadata.identity", async (t) => {
  const db = openDb(t);
  const out = await handleJsonRpcRequest(db, rpc("SendMessage", { message: { parts: [{ text: "hello" }] } }));
  assert.ok(out.error);
  assert.equal(out.error.code, JSON_RPC_ERROR_CODE.INVALID_PARAMS);
});

test("SendMessage: posts to the board and returns a COMPLETED task with the content as an artifact", async (t) => {
  const db = openDb(t);
  const out = await handleJsonRpcRequest(db, rpc("SendMessage", {
    message: {
      parts: [{ text: "a real A2A message" }],
      metadata: { identity: IDENTITY, topic: "a2a-test-topic" },
    },
  }));
  assert.equal(out.error, undefined);
  assert.ok(out.result.task);
  assert.equal(out.result.task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(out.result.task.contextId, "a2a-test-topic");
  assert.equal(out.result.task.artifacts[0].parts[0].text, "a real A2A message");
});

test("GetTask: retrieves a previously-sent message by its task (= message) id", async (t) => {
  const db = openDb(t);
  const sent = await handleJsonRpcRequest(db, rpc("SendMessage", {
    message: { parts: [{ text: "findable" }], metadata: { identity: IDENTITY } },
  }));
  const taskId = sent.result.task.id;

  const fetched = await handleJsonRpcRequest(db, rpc("GetTask", { id: taskId }));
  assert.equal(fetched.error, undefined);
  assert.equal(fetched.result.id, taskId);
  assert.equal(fetched.result.status.state, "TASK_STATE_COMPLETED");
});

test("GetTask: unknown id returns TaskNotFoundError (-32001)", async (t) => {
  const db = openDb(t);
  const out = await handleJsonRpcRequest(db, rpc("GetTask", { id: "does-not-exist" }));
  assert.ok(out.error);
  assert.equal(out.error.code, JSON_RPC_ERROR_CODE.TASK_NOT_FOUND);
});

test("ListTasks: filters by contextId (topic)", async (t) => {
  const db = openDb(t);
  await handleJsonRpcRequest(db, rpc("SendMessage", { message: { parts: [{ text: "in topic a" }], metadata: { identity: IDENTITY, topic: "topic-a" } } }));
  await handleJsonRpcRequest(db, rpc("SendMessage", { message: { parts: [{ text: "in topic b" }], metadata: { identity: IDENTITY, topic: "topic-b" } } }));

  const out = await handleJsonRpcRequest(db, rpc("ListTasks", { contextId: "topic-a" }));
  assert.equal(out.result.tasks.length, 1);
  assert.equal(out.result.tasks[0].contextId, "topic-a");
});

test("CancelTask: always TaskNotCancelableError, since every task is already terminal", async (t) => {
  const db = openDb(t);
  const sent = await handleJsonRpcRequest(db, rpc("SendMessage", {
    message: { parts: [{ text: "cannot be canceled" }], metadata: { identity: IDENTITY } },
  }));

  const out = await handleJsonRpcRequest(db, rpc("CancelTask", { id: sent.result.task.id }));
  assert.ok(out.error);
  assert.equal(out.error.code, JSON_RPC_ERROR_CODE.TASK_NOT_CANCELABLE);
});

test("CancelTask: unknown id still reports TaskNotFoundError, not TaskNotCancelableError", async (t) => {
  const db = openDb(t);
  const out = await handleJsonRpcRequest(db, rpc("CancelTask", { id: "does-not-exist" }));
  assert.equal(out.error.code, JSON_RPC_ERROR_CODE.TASK_NOT_FOUND);
});

test("unknown method returns METHOD_NOT_FOUND (-32601)", async (t) => {
  const db = openDb(t);
  const out = await handleJsonRpcRequest(db, rpc("DeleteEverything", {}));
  assert.equal(out.error.code, JSON_RPC_ERROR_CODE.METHOD_NOT_FOUND);
});

test("malformed JSON-RPC envelope returns INVALID_REQUEST (-32600)", async (t) => {
  const db = openDb(t);
  const out = await handleJsonRpcRequest(db, JSON.stringify({ method: "SendMessage" }));
  assert.equal(out.error.code, -32600);
});
