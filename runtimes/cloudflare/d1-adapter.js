"use strict";

// Same {get, all, run, exec} interface as runtimes/local/sqlite-adapter.js,
// implemented against Cloudflare D1's native async binding API, so core/*.js
// runs unmodified on either runtime.

class D1Adapter {
  constructor(db) {
    if (!db) throw new Error("D1Adapter requires a D1Database binding");
    this.db = db;
  }

  async get(sql, params = []) {
    const row = await this.db.prepare(sql).bind(...params).first();
    return row ?? undefined;
  }

  async all(sql, params = []) {
    const result = await this.db.prepare(sql).bind(...params).all();
    return result.results;
  }

  async run(sql, params = []) {
    const result = await this.db.prepare(sql).bind(...params).run();
    return {
      changes: result.meta.changes,
      lastInsertRowid: result.meta.last_row_id,
    };
  }

  async exec(sql) {
    await this.db.exec(sql);
  }
}

module.exports = { D1Adapter };
