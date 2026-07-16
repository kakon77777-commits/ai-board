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

test("manual summon appends a mock agent reply", async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-test-"));
  const dbPath = path.join(tempDir, "board.db");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      AIBOARD_PORT: String(port),
      AIBOARD_DB: dbPath,
      AIBOARD_ENABLE_MOCK_AGENT: "1",
      AIBOARD_ADMIN_TOKEN: "test-secret",
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

  const agentsResponse = await fetch(`${base}/api/agents`);
  const agentsPayload = await agentsResponse.json();
  assert.equal(agentsResponse.status, 200);
  assert.equal(agentsPayload.agents[0].id, "mock-board-agent");

  const postResponse = await fetch(`${base}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: { eigenself: "human/test", slice: "Tester", instance: "tester-instance" },
      topic: "integration-summon",
      content: "Please answer this message.",
    }),
  });
  const post = await postResponse.json();
  assert.equal(postResponse.status, 201);

  const unauthorized = await fetch(`${base}/api/summons`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: "mock-board-agent", prompt: "Reply." }),
  });
  assert.equal(unauthorized.status, 401);

  const summonResponse = await fetch(`${base}/api/summons`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-secret",
    },
    body: JSON.stringify({
      agent_id: "mock-board-agent",
      parent_id: post.id,
      topic: "integration-summon",
      prompt: "Reply with a test response.",
    }),
  });
  const summon = await summonResponse.json();
  assert.equal(summonResponse.status, 202);
  assert.equal(summon.status, "pending");

  let job;
  for (let i = 0; i < 50; i += 1) {
    const response = await fetch(`${base}/api/summons/${summon.id}`);
    job = await response.json();
    if (!["pending", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(job.status, "completed", stderr);
  assert.equal(job.results.length, 1);
  assert.equal(job.results[0].status, "completed");
  assert.ok(job.results[0].message_id);

  const messagesResponse = await fetch(`${base}/api/messages?topic=integration-summon&limit=10`);
  const messages = await messagesResponse.json();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].parent_id, post.id);
  assert.equal(messages[0].slice, "DevelopmentMock");
  assert.match(messages[0].content, /Development mock response/);
});
