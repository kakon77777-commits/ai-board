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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("thread export and GitHub delivery previews do not create external side effects", async (t) => {
  const port = 25000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-delivery-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      AIBOARD_PORT: String(port),
      AIBOARD_DB: path.join(tempDir, "board.db"),
      AIBOARD_GITHUB_REPO: "example/ai-board",
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
  const identity = { eigenself: "human/test", slice: "Deliverer", instance: "deliverer-1" };
  const root = await postJson(`${base}/api/messages`, {
    identity, topic: "delivery-test", content: "Root delivery message.",
  });
  assert.equal(root.response.status, 201, stderr);
  const reply = await postJson(`${base}/api/messages`, {
    identity, topic: "delivery-test", message_type: "reply", parent_id: root.body.id,
    content: "Reply included in delivery.",
  });
  assert.equal(reply.response.status, 201, stderr);

  const markdownResponse = await fetch(`${base}/api/threads/${root.body.id}/markdown`);
  const markdown = await markdownResponse.text();
  assert.equal(markdownResponse.status, 200);
  assert.match(markdown, /Root delivery message/);
  assert.match(markdown, /Reply included in delivery/);

  const issue = await postJson(`${base}/api/deliveries/github/issue`, {
    thread_id: root.body.id,
    title: "Review AI Board thread",
    labels: ["ai-board"],
  });
  assert.equal(issue.response.status, 200);
  assert.equal(issue.body.preview, true);
  assert.equal(issue.body.request.repository, "example/ai-board");
  assert.match(issue.body.request.body, /append-only thread/);

  const diff = await postJson(`${base}/api/diff-proposals`, {
    identity,
    target_file: "server.js",
    original: "const version = 1;",
    proposed: "const version = 2;",
    rationale: "Advance the delivery version.",
  });
  assert.equal(diff.response.status, 201, stderr);

  const pr = await postJson(`${base}/api/deliveries/github/draft-pr`, {
    proposal_id: diff.body.id,
  });
  assert.equal(pr.response.status, 200);
  assert.equal(pr.body.preview, true);
  assert.equal(pr.body.request.draft, true);
  assert.equal(pr.body.request.target_file, "server.js");
  assert.match(pr.body.request.head, /^ai-board\//);
  assert.equal("proposed_text" in pr.body.request, false);

  const blockedExecution = await postJson(`${base}/api/deliveries/github/issue`, {
    thread_id: root.body.id,
    execute: true,
  });
  assert.equal(blockedExecution.response.status, 503);
  assert.match(blockedExecution.body.error, /AIBOARD_ADMIN_TOKEN/);

  const deliveries = await (await fetch(`${base}/api/deliveries`)).json();
  assert.equal(deliveries.status.repository, "example/ai-board");
  assert.equal(deliveries.status.write_enabled, false);
  assert.equal(deliveries.records.length, 0);
});
