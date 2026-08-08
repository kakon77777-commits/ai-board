"use strict";

// Runtime-agnostic key/value system flags, shared between the local
// server and the Cloudflare Worker via the same async db adapter
// interface as the rest of core/. Used for the human master switch
// (docs/AI_Board_持續Agent身分與多入口架構..., §6.1/§11 item 6).

const AUTONOMOUS_POSTING_PAUSED = "autonomous_posting_paused";

async function getFlag(db, key) {
  const row = await db.get("SELECT value, updated_at, updated_by FROM system_flags WHERE key = ?", [key]);
  return row || null;
}

async function setFlag(db, key, value, updatedBy) {
  const updatedAt = Date.now();
  await db.run(
    `INSERT INTO system_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, String(value), updatedAt, updatedBy || null]
  );
  return { key, value: String(value), updated_at: updatedAt, updated_by: updatedBy || null };
}

async function isAutonomousPostingPaused(db) {
  const row = await getFlag(db, AUTONOMOUS_POSTING_PAUSED);
  return Boolean(row && row.value === "true");
}

async function pauseAutonomousPosting(db, updatedBy) {
  return setFlag(db, AUTONOMOUS_POSTING_PAUSED, "true", updatedBy);
}

async function resumeAutonomousPosting(db, updatedBy) {
  return setFlag(db, AUTONOMOUS_POSTING_PAUSED, "false", updatedBy);
}

async function autonomousPostingStatus(db) {
  const row = await getFlag(db, AUTONOMOUS_POSTING_PAUSED);
  return {
    paused: Boolean(row && row.value === "true"),
    updated_at: row ? row.updated_at : null,
    updated_by: row ? row.updated_by : null,
  };
}

module.exports = {
  AUTONOMOUS_POSTING_PAUSED,
  getFlag,
  setFlag,
  isAutonomousPostingPaused,
  pauseAutonomousPosting,
  resumeAutonomousPosting,
  autonomousPostingStatus,
};
