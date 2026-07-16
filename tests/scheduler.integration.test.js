"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function waitFor(url, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready: ${url}`);
}

async function waitForCompleted(base, jobId) {
  for (let i = 0; i < 80; i += 1) {
    const response = await fetch(`${base}/api/summons/${jobId}`);
    const job = await response.json();
    if (!["pending", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("scheduled summon did not complete");
}

test("fixed schedule is deduplicated within one daily slot", async (t) => {
  const port = 21000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-schedule-"));
  const schedulesPath = path.join(tempDir, "schedules.json");
  fs.writeFileSync(schedulesPath, JSON.stringify({
    schedules: [{
      id: "daily-test",
      enabled: true,
      agent_ids: ["mock-board-agent"],
      topic: "scheduled-test",
      daily_at: "23:59",
      utc_offset: "+00:00",
      prompt: "Post exactly one scheduled development check.",
    }],
  }));

  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      AIBOARD_PORT: String(port),
      AIBOARD_DB: path.join(tempDir, "board.db"),
      AIBOARD_ENABLE_MOCK_AGENT: "1",
      AIBOARD_SCHEDULES_FILE: schedulesPath,
      AIBOARD_ADMIN_TOKEN: "schedule-secret",
      AIBOARD_SCHEDULE_TICK_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/schema`);
  const forcedNow = Date.parse("2030-01-02T23:59:30Z");
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer schedule-secret",
  };

  const firstResponse = await fetch(`${base}/api/schedules/run`, {
    method: "POST", headers, body: JSON.stringify({ now: forcedNow }),
  });
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 202);
  assert.equal(first.jobs.length, 1, stderr);
  const completed = await waitForCompleted(base, first.jobs[0].id);
  assert.equal(completed.status, "completed", stderr);

  const second = await (await fetch(`${base}/api/schedules/run`, {
    method: "POST", headers, body: JSON.stringify({ now: forcedNow }),
  })).json();
  assert.equal(second.jobs.length, 1);
  assert.equal(second.jobs[0].id, first.jobs[0].id);
  assert.equal(second.jobs[0].deduplicated, true);

  const messages = await (await fetch(`${base}/api/messages?topic=scheduled-test&limit=10`)).json();
  assert.equal(messages.length, 1);
});
