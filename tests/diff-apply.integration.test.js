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

function spawnBoard(t, port, dbDir, extraEnv, extraCleanupDirs = []) {
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
    for (const dir of [dbDir, ...extraCleanupDirs]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return { child, getStderr: () => stderr };
}

test("diff-apply is disabled unless AIBOARD_APPLY_ROOT is configured", async (t) => {
  const port = 26000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-noapply-"));
  const { getStderr } = spawnBoard(t, port, tempDir, {});
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/schema`);

  const schema = await (await fetch(`${base}/api/schema`)).json();
  assert.equal(schema.collaboration.diff_apply.enabled, false, getStderr());

  const identity = { eigenself: "human/test", slice: "Applier", instance: "applier-disabled" };
  const diff = await postJson(`${base}/api/diff-proposals`, {
    identity, target_file: "notes.txt", original: "", proposed: "hello", rationale: "test",
  });
  assert.equal(diff.response.status, 201, getStderr());

  const preview = await postJson(`${base}/api/diff-proposals/${diff.body.id}/apply`, {});
  assert.equal(preview.response.status, 503);
  assert.match(preview.body.error, /AIBOARD_APPLY_ROOT/);
});

test("diff-apply writes to disk with a matching original and a valid admin token", async (t) => {
  const port = 26500 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-apply-db-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-apply-workspace-"));
  const { getStderr } = spawnBoard(t, port, tempDir, {
    AIBOARD_APPLY_ROOT: workspaceDir,
    AIBOARD_ADMIN_TOKEN: "apply-secret",
  }, [workspaceDir]);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/schema`);

  const schema = await (await fetch(`${base}/api/schema`)).json();
  assert.equal(schema.collaboration.diff_apply.enabled, true, getStderr());

  const identity = { eigenself: "human/test", slice: "Applier", instance: "applier-1" };

  // --- new file creation: original is empty, file does not yet exist ---
  const created = await postJson(`${base}/api/diff-proposals`, {
    identity, target_file: "notes/hello.txt", original: "", proposed: "hello world\n", rationale: "create the file",
  });
  assert.equal(created.response.status, 201, getStderr());

  const preview = await postJson(`${base}/api/diff-proposals/${created.body.id}/apply`, {});
  assert.equal(preview.response.status, 200, getStderr());
  assert.equal(preview.body.preview, true);
  assert.equal(preview.body.file_exists, false);
  assert.equal(preview.body.matches_original, true);
  assert.equal(fs.existsSync(path.join(workspaceDir, "notes/hello.txt")), false, "preview must not touch disk");

  const noAuth = await postJson(`${base}/api/diff-proposals/${created.body.id}/apply`, { execute: true });
  assert.equal(noAuth.response.status, 401);
  assert.equal(fs.existsSync(path.join(workspaceDir, "notes/hello.txt")), false);

  const applied = await postJson(
    `${base}/api/diff-proposals/${created.body.id}/apply`,
    { execute: true },
    { Authorization: "Bearer apply-secret" }
  );
  assert.equal(applied.response.status, 201, getStderr());
  assert.equal(applied.body.applied, true);
  const writtenPath = path.join(workspaceDir, "notes", "hello.txt");
  assert.equal(fs.readFileSync(writtenPath, "utf8"), "hello world\n");

  // --- path traversal is rejected at proposal creation time, before it ever reaches apply ---
  const traversal = await postJson(`${base}/api/diff-proposals`, {
    identity, target_file: "../outside.txt", original: "", proposed: "escape", rationale: "should be rejected",
  });
  assert.equal(traversal.response.status, 500, getStderr());
  assert.match(traversal.body.error, /safe relative path/);
  assert.equal(fs.existsSync(path.join(workspaceDir, "..", "outside.txt")), false);

  // --- stale/conflicting original_text must be refused, and must not touch the file ---
  const stale = await postJson(`${base}/api/diff-proposals`, {
    identity, target_file: "notes/hello.txt", original: "this is not the current content", proposed: "clobbered", rationale: "stale base",
  });
  assert.equal(stale.response.status, 201, getStderr());

  const stalePreview = await postJson(`${base}/api/diff-proposals/${stale.body.id}/apply`, {});
  assert.equal(stalePreview.body.matches_original, false);

  const staleApply = await postJson(
    `${base}/api/diff-proposals/${stale.body.id}/apply`,
    { execute: true },
    { Authorization: "Bearer apply-secret" }
  );
  assert.equal(staleApply.response.status, 500);
  assert.match(staleApply.body.error, /does not match/);
  assert.equal(fs.readFileSync(writtenPath, "utf8"), "hello world\n", "file must be unchanged after a refused apply");

  // --- audit trail records both the completed and the failed attempt ---
  const audit = await (await fetch(`${base}/api/diff-proposal-applications`)).json();
  assert.equal(audit.status.enabled, true);
  const statuses = audit.applications.map((row) => row.status);
  assert.ok(statuses.includes("completed"));
  assert.ok(statuses.includes("failed"));
});
