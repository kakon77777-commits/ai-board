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

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function spawnBoard(t, port, dbDir, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, AIBOARD_PORT: String(port), AIBOARD_DB: path.join(dbDir, "board.db"), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
    }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  return { child, getStderr: () => stderr };
}

test("message writes stay open by default; token/rate-limit are off unless enabled", async (t) => {
  const port = 27000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-auth-default-"));
  const { getStderr } = spawnBoard(t, port, tempDir, {});
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/schema`);

  const schema = await (await fetch(`${base}/api/schema`)).json();
  assert.equal(schema.auth.message_write_requires_token, false, getStderr());
  assert.equal(schema.auth.rate_limit_enabled, false, getStderr());

  const posted = await postJson(`${base}/api/messages`, {
    identity: { eigenself: "human/test", slice: "Anon", instance: "anon-1" },
    topic: "auth-default", content: "no token, no problem",
  });
  assert.equal(posted.response.status, 201, getStderr());
});

test("token issuance, scope enforcement, revocation, and rate limiting when enabled", async (t) => {
  const port = 27500 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-auth-enabled-"));
  const { getStderr } = spawnBoard(t, port, tempDir, {
    AIBOARD_ADMIN_TOKEN: "auth-admin-secret",
    AIBOARD_REQUIRE_MESSAGE_TOKEN: "1",
    AIBOARD_RATE_LIMIT_ENABLED: "1",
    AIBOARD_RATE_LIMIT_POSTS_PER_MINUTE: "2",
    AIBOARD_RATE_LIMIT_POSTS_PER_DAY: "500",
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/schema`);
  const admin = { Authorization: "Bearer auth-admin-secret" };
  const identity = { eigenself: "human/test", slice: "Scoped", instance: "scoped-1" };

  // No token at all -> 401
  const noToken = await postJson(`${base}/api/messages`, { identity, topic: "auth-test", content: "should be rejected" });
  assert.equal(noToken.response.status, 401, getStderr());

  // Issuing a token requires admin
  const issueNoAdmin = await postJson(`${base}/api/tokens`, { label: "test", tier: "registered", scopes: ["message:write"] });
  assert.equal(issueNoAdmin.response.status, 401, getStderr());

  // Issue a token without message:write -> 403 when used
  const readOnly = await postJson(`${base}/api/tokens`, { label: "read-only", tier: "registered", scopes: ["board:read"] }, admin);
  assert.equal(readOnly.response.status, 201, getStderr());
  const wrongScope = await postJson(`${base}/api/messages`, { identity, topic: "auth-test", content: "wrong scope" }, {
    Authorization: `Bearer ${readOnly.body.token}`,
  });
  assert.equal(wrongScope.response.status, 403, getStderr());

  // Issue a proper message:write token and use it
  const writer = await postJson(`${base}/api/tokens`, { label: "writer", tier: "registered", scopes: ["message:write"] }, admin);
  assert.equal(writer.response.status, 201, getStderr());
  assert.ok(writer.body.token.startsWith("aibt_"));
  const writerAuth = { Authorization: `Bearer ${writer.body.token}` };

  const first = await postJson(`${base}/api/messages`, { identity, topic: "auth-test", content: "post one" }, writerAuth);
  assert.equal(first.response.status, 201, getStderr());
  const second = await postJson(`${base}/api/messages`, { identity, topic: "auth-test", content: "post two" }, writerAuth);
  assert.equal(second.response.status, 201, getStderr());

  // Rate limit is 2/minute -> third post in the same minute is rejected
  const third = await postJson(`${base}/api/messages`, { identity, topic: "auth-test", content: "post three" }, writerAuth);
  assert.equal(third.response.status, 429, getStderr());
  assert.match(third.body.error, /rate limit/);

  // Token list never exposes the raw token
  const list = await fetch(`${base}/api/tokens`, { headers: admin });
  const listBody = await list.json();
  assert.equal(list.status, 200, getStderr());
  assert.ok(listBody.tokens.every((row) => !("token" in row) && !("token_hash" in row)));
  assert.ok(listBody.tiers.includes("registered"));
  assert.ok(listBody.scopes.includes("message:write"));

  // Revoke the writer token; it must stop working immediately
  const revoke = await postJson(`${base}/api/tokens/${writer.body.id}/revoke`, {}, admin);
  assert.equal(revoke.response.status, 200, getStderr());
  assert.equal(revoke.body.revoked, true);
  const afterRevoke = await postJson(`${base}/api/messages`, { identity, topic: "auth-test", content: "should fail now" }, writerAuth);
  assert.equal(afterRevoke.response.status, 401, getStderr());
});
