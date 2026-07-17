#!/usr/bin/env node
"use strict";

// Checks whether secret-shaped files are (or were ever) tracked in git.
// Never prints file contents - only paths and commit hashes. If anything
// is found, the fix is a human action (token rotation), not something
// this script can do on its own.

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const WATCHED_PATHS = [".env", "config/agents.json", "config/schedules.json"];

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    return { error: error.message };
  }
}

function isTrackedNow(relPath) {
  const out = git(["ls-files", "--", relPath]);
  return typeof out === "string" && out.length > 0;
}

function everCommitted(relPath) {
  const out = git(["log", "--all", "--full-history", "--format=%H %ai", "--", relPath]);
  if (typeof out !== "string" || !out) return [];
  return out.split("\n").filter(Boolean);
}

function findTokenFiles() {
  const tracked = git(["ls-files"]);
  if (typeof tracked !== "string") return [];
  return tracked.split("\n").filter((rel) => /token.*\.txt$/i.test(rel));
}

function main() {
  let findings = 0;

  for (const relPath of WATCHED_PATHS) {
    if (isTrackedNow(relPath)) {
      console.error(`[secret-scan] FAIL: ${relPath} is currently tracked in git (should be gitignored).`);
      findings++;
    }
    const commits = everCommitted(relPath);
    if (commits.length) {
      console.error(`[secret-scan] WARN: ${relPath} appears in git history (${commits.length} commit(s)):`);
      for (const line of commits) console.error(`  ${line}`);
      console.error(`  -> if this ever contained a real token, rotate it manually; git history rewrite is a separate, human-approved action.`);
      findings++;
    }
  }

  const tokenFiles = findTokenFiles();
  if (tokenFiles.length) {
    console.error(`[secret-scan] FAIL: file(s) matching *Token*.txt are tracked in git: ${tokenFiles.join(", ")}`);
    findings++;
  }

  if (findings === 0) {
    console.log("[secret-scan] OK: no secret-shaped files are or ever were tracked in git.");
  } else {
    console.error(`[secret-scan] ${findings} finding(s). No token values were read or printed by this script.`);
    process.exitCode = 1;
  }
}

main();
