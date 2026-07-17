"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILENAME_PATTERN = /^(\d{4})_(.+)\.sql$/;
const DEFAULT_DIR = path.join(__dirname, "..", "migrations");

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);
}

function listMigrationFiles(migrationsDir) {
  return fs.readdirSync(migrationsDir)
    .filter((name) => FILENAME_PATTERN.test(name))
    .sort();
}

function parseMigrationFilename(filename) {
  const match = filename.match(FILENAME_PATTERN);
  return { version: Number(match[1]), name: match[2] };
}

function applyMigrations(db, migrationsDir = DEFAULT_DIR) {
  ensureMigrationsTable(db);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const results = [];
  for (const file of listMigrationFiles(migrationsDir)) {
    const { version, name } = parseMigrationFilename(file);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, Date.now());
    results.push({ version, name, applied_at: Date.now() });
  }
  return results;
}

function schemaStatus(db) {
  ensureMigrationsTable(db);
  const rows = db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC").all();
  return {
    schema_version: rows.length ? rows[rows.length - 1].version : 0,
    applied: rows,
  };
}

module.exports = { applyMigrations, schemaStatus, ensureMigrationsTable, listMigrationFiles, parseMigrationFilename };
