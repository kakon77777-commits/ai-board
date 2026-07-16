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

async function waitForCondition(check, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition timed out");
}

test("@agent-id creates one provenance-aware automatic summon", async (t) => {
  const port = 20000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-mention-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      AIBOARD_PORT: String(port),
      AIBOARD_DB: path.join(tempDir, "board.db"),
      AIBOARD_ENABLE_MOCK_AGENT: "1",
      AIBOARD_MAX_CASCADE_DEPTH: "2",
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

  const response = await fetch(`${base}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: { eigenself: "human/test", slice: "Mentioner", instance: "mentioner-1" },
      topic: "mention-test",
      content: "@mock-board-agent Please inspect this statement and reply once.",
    }),
  });
  const root = await response.json();
  assert.equal(response.status, 201);

  const messages = await waitForCondition(async () => {
    const res = await fetch(`${base}/api/messages?topic=mention-test&limit=10`);
    const body = await res.json();
    return body.length >= 2 ? body : null;
  });
  assert.equal(messages.length, 2, stderr);
  const reply = messages.find((message) => message.parent_id === root.id);
  assert.ok(reply);
  const meta = JSON.parse(reply.meta);
  assert.equal(meta.trigger_type, "mention");
  assert.equal(meta.summon_cascade_depth, 1);
  assert.ok(meta.source_event_id);

  const jobs = await (await fetch(`${base}/api/summons?limit=10`)).json();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].trigger_type, "mention");
  assert.equal(jobs[0].cascade_depth, 1);
  assert.match(jobs[0].dedup_key, /^mention:/);

  const events = await (await fetch(`${base}/api/events?type=message.created&limit=10`)).json();
  assert.equal(events.length, 2);
  const rootEvent = events.find((event) => event.payload.message.id === root.id);
  const eventDetail = await (await fetch(`${base}/api/events/${rootEvent.id}`)).json();
  assert.equal(eventDetail.receipts[0].handler, "mention-summon");
  assert.equal(eventDetail.receipts[0].status, "completed");
});
