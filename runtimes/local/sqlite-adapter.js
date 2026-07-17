"use strict";

// Wraps node:sqlite's synchronous DatabaseSync behind the same async
// Database interface a Cloudflare D1 adapter will eventually implement:
//   get(sql, params)  -> Promise<row | undefined>
//   all(sql, params)  -> Promise<row[]>
//   run(sql, params)  -> Promise<{ changes, lastInsertRowid }>
//   exec(sql)         -> Promise<void>
//
// The underlying calls are synchronous; wrapping them in Promise.resolve()
// costs nothing locally and lets core/ code be written once, async, and
// run unmodified against either backend.

class SqliteAdapter {
  constructor(db) {
    if (!db) throw new Error("SqliteAdapter requires a node:sqlite DatabaseSync instance");
    this.db = db;
  }

  async get(sql, params = []) {
    return this.db.prepare(sql).get(...params);
  }

  async all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  async run(sql, params = []) {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  async exec(sql) {
    this.db.exec(sql);
  }
}

module.exports = { SqliteAdapter };
