"use strict";

// Mock-based unit tests for runtimes/cloudflare/d1-adapter.js. There is no
// live Cloudflare/Miniflare environment in this test run, so these tests
// construct a fake D1Database matching the documented
// prepare().bind().first()/.all()/.run() and exec() shapes, and assert the
// adapter translates calls and return values correctly at that boundary.

const assert = require("node:assert/strict");
const test = require("node:test");

const { D1Adapter } = require("../runtimes/cloudflare/d1-adapter.js");

function makeFakeD1({ first, all, run } = {}) {
  const calls = { prepare: [], bind: [], exec: [] };
  const db = {
    prepare(sql) {
      calls.prepare.push(sql);
      return {
        bind(...params) {
          calls.bind.push(params);
          return {
            async first() {
              return typeof first === "function" ? first() : (first ?? null);
            },
            async all() {
              return typeof all === "function" ? all() : (all ?? { results: [], success: true, meta: {} });
            },
            async run() {
              return typeof run === "function" ? run() : (run ?? { success: true, meta: { changes: 0, last_row_id: 0 } });
            },
          };
        },
      };
    },
    async exec(sql) {
      calls.exec.push(sql);
      return { count: 1, duration: 0 };
    },
  };
  return { db, calls };
}

test("D1Adapter.get: binds params, returns the first-row object", async () => {
  const row = { id: "m1", content: "hello" };
  const { db, calls } = makeFakeD1({ first: row });
  const adapter = new D1Adapter(db);

  const result = await adapter.get("SELECT * FROM messages WHERE id = ?", ["m1"]);

  assert.equal(calls.prepare[0], "SELECT * FROM messages WHERE id = ?");
  assert.deepEqual(calls.bind[0], ["m1"]);
  assert.deepEqual(result, row);
});

test("D1Adapter.get: returns undefined (not null) when D1 finds no row", async () => {
  const { db } = makeFakeD1({ first: null });
  const adapter = new D1Adapter(db);

  const result = await adapter.get("SELECT * FROM messages WHERE id = ?", ["missing"]);

  assert.equal(result, undefined);
});

test("D1Adapter.all: unwraps the .results array from D1's {results, success, meta} shape", async () => {
  const rows = [{ id: "a" }, { id: "b" }];
  const { db, calls } = makeFakeD1({ all: { results: rows, success: true, meta: { duration: 1 } } });
  const adapter = new D1Adapter(db);

  const result = await adapter.all("SELECT * FROM messages WHERE topic = ?", ["core-test"]);

  assert.deepEqual(calls.bind[0], ["core-test"]);
  assert.deepEqual(result, rows);
});

test("D1Adapter.run: maps D1's meta.changes/last_row_id to changes/lastInsertRowid", async () => {
  const { db, calls } = makeFakeD1({
    run: { success: true, meta: { changes: 1, last_row_id: 42, duration: 1 } },
  });
  const adapter = new D1Adapter(db);

  const result = await adapter.run("INSERT INTO messages (id, content) VALUES (?, ?)", ["m2", "hi"]);

  assert.deepEqual(calls.bind[0], ["m2", "hi"]);
  assert.deepEqual(result, { changes: 1, lastInsertRowid: 42 });
});

test("D1Adapter: get/all/run default params to [] when omitted", async () => {
  const { db, calls } = makeFakeD1();
  const adapter = new D1Adapter(db);

  await adapter.get("SELECT 1");
  await adapter.all("SELECT 1");
  await adapter.run("DELETE FROM messages");

  assert.deepEqual(calls.bind, [[], [], []]);
});

test("D1Adapter.exec: forwards raw multi-statement SQL to db.exec for migrations", async () => {
  const { db, calls } = makeFakeD1();
  const adapter = new D1Adapter(db);

  await adapter.exec("CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);");

  assert.equal(calls.exec.length, 1);
  assert.match(calls.exec[0], /CREATE TABLE a/);
});

test("D1Adapter: constructor throws without a db binding", () => {
  assert.throws(() => new D1Adapter(undefined), /requires a D1Database binding/);
});
