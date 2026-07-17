#!/usr/bin/env node
"use strict";

// Build a clean, reproducible release package: no secrets, no .git, no
// local runtime data. Produces dist/release-staging/ (the file set) and
// dist/MANIFEST.md (path/bytes/SHA-256 per file), then attempts to zip
// the staging directory using whatever archiver is available on this OS.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const STAGING_DIR = path.join(DIST_DIR, "release-staging");

// Directories excluded entirely (never descended into).
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "dist", "coverage", "logs", "_backup-v0.3.1",
]);

// Files excluded by exact name or pattern, matching task-book §3.1.
const EXCLUDED_FILE_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.log$/,
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /^config[\\/]agents\.json$/,
  /^config[\\/]schedules\.json$/,
  /Token.*\.txt$/i,
  /^ai-board-main-.*\.zip$/,
];

function isExcludedFile(relPath) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(relPath));
}

// Dotfiles/dotdirs are skipped by default (editor state, stray .env variants);
// these specific ones are known-safe and allowed through.
const ALLOWED_DOTFILES = new Set([".env.example", ".gitattributes", ".gitignore"]);
const ALLOWED_DOTDIRS = new Set([".github"]);

function walk(dir, baseDir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      if (entry.isDirectory() && !ALLOWED_DOTDIRS.has(entry.name)) continue;
      if (entry.isFile() && !ALLOWED_DOTFILES.has(entry.name)) continue;
    }
    const abs = path.join(dir, entry.name);
    const rel = path.relative(baseDir, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(abs, baseDir, out);
    } else if (entry.isFile()) {
      if (isExcludedFile(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildManifest(files, baseDir) {
  const rows = files
    .map((rel) => {
      const abs = path.join(baseDir, rel);
      const bytes = fs.statSync(abs).size;
      return { rel, bytes, sha256: sha256(abs) };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const pkg = require(path.join(ROOT, "package.json"));
  const lines = [
    `# AI Board Release Manifest`,
    ``,
    `Version: ${pkg.version}`,
    `Generated: ${new Date().toISOString()}`,
    `Files: ${rows.length}`,
    ``,
    `| Path | Bytes | SHA-256 |`,
    `|---|---:|---|`,
    ...rows.map((row) => `| \`${row.rel}\` | ${row.bytes} | \`${row.sha256}\` |`),
    ``,
  ];
  return lines.join("\n");
}

function tryZip(stagingDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  try {
    execFileSync("zip", ["-r", "-X", zipPath, "."], { cwd: stagingDir, stdio: "ignore" });
    return "zip";
  } catch {}
  if (process.platform === "win32") {
    try {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${zipPath}' -Force`],
        { stdio: "ignore" }
      );
      return "Compress-Archive";
    } catch {}
  }
  return null;
}

function main() {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const files = walk(ROOT, ROOT, []);
  for (const rel of files) {
    const dest = path.join(STAGING_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }

  const manifest = buildManifest(files, ROOT);
  fs.writeFileSync(path.join(DIST_DIR, "MANIFEST.md"), manifest);

  const pkg = require(path.join(ROOT, "package.json"));
  const zipPath = path.join(DIST_DIR, `ai-board-release-v${pkg.version}.zip`);
  const tool = tryZip(STAGING_DIR, zipPath);

  console.log(`[package:release] ${files.length} files staged`);
  console.log(`[package:release] manifest written to ${path.relative(ROOT, path.join(DIST_DIR, "MANIFEST.md"))}`);
  if (tool) {
    console.log(`[package:release] zip created via ${tool}: ${path.relative(ROOT, zipPath)}`);
    // Remove the staging copy once it's safely zipped - otherwise it sits in
    // dist/ as a full second copy of the source tree, and tools like
    // `node --test` (which recurses by default) will pick up its test files too.
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  } else {
    console.log(`[package:release] no zip tool found (tried 'zip', 'Compress-Archive'); staging left at ${path.relative(ROOT, STAGING_DIR)} to zip manually.`);
  }

  const leaked = files.filter((rel) =>
    /\.env($|\.)/.test(rel) ||
    /\.db(-wal|-shm)?$/.test(rel) ||
    /\.log$/.test(rel) ||
    rel === ".git" || rel.startsWith(".git/")
  );
  if (leaked.length) {
    console.error(`[package:release] FAIL: secret/db/log/git files present in staged release: ${leaked.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`[package:release] OK: no secret, database, log, or .git files in the staged release.`);
  }
}

main();
