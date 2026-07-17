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

async function postMessage(base, payload) {
  const response = await fetch(`${base}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test("search, identity negotiation, templates and diff proposals share the ledger", async (t) => {
  const port = 22000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-collab-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, AIBOARD_PORT: String(port), AIBOARD_DB: path.join(tempDir, "board.db") },
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

  const identity = { eigenself: "human/test", slice: "Architect", instance: "architect-1" };
  const first = await postMessage(base, {
    identity, topic: "retrieval-test", content: "Semantic coupling and persistent assembly are the key concepts.",
  });
  assert.equal(first.response.status, 201, stderr);
  const objection = await postMessage(base, {
    identity: { eigenself: "ai/reviewer", slice: "Reviewer", instance: "reviewer-1" },
    topic: "retrieval-test", message_type: "objection", parent_id: first.body.id,
    content: "The identity claim and semantic coupling conclusion require qualification.",
  });
  assert.equal(objection.response.status, 201, stderr);

  const searchResponse = await fetch(`${base}/api/search?q=semantic%20coupling`);
  const search = await searchResponse.json();
  assert.equal(searchResponse.status, 200, stderr);
  assert.ok(search.results.some((row) => row.id === first.body.id));

  const negotiations = await (await fetch(`${base}/api/identity-negotiations?instance=architect-1`)).json();
  assert.equal(negotiations.length, 1);
  assert.equal(negotiations[0].contested, true);
  assert.equal(negotiations[0].objections, 1);

  const renderedResponse = await fetch(`${base}/api/templates/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "handoff", values: { project: "AI Board", current_state: "Summoning works." } }),
  });
  const rendered = await renderedResponse.json();
  assert.equal(renderedResponse.status, 200);
  assert.match(rendered.content, /Project Handoff: AI Board/);

  const diffResponse = await fetch(`${base}/api/diff-proposals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity,
      topic: "retrieval-test",
      target_file: "src/example.js",
      original: "const value = 1;",
      proposed: "const value = 2;",
      rationale: "Update the example value.",
    }),
  });
  const diff = await diffResponse.json();
  assert.equal(diffResponse.status, 201, stderr);
  assert.equal(diff.target_file, "src/example.js");

  const patchResponse = await fetch(`${base}${diff.patch_url}`);
  const patch = await patchResponse.text();
  assert.equal(patchResponse.status, 200);
  assert.match(patch, /--- a\/src\/example\.js/);
  assert.match(patch, /\+const value = 2;/);

  const diffMessages = await (await fetch(`${base}/api/messages?message_type=diff&limit=10`)).json();
  assert.equal(diffMessages.length, 1);
  assert.equal(JSON.parse(diffMessages[0].meta).diff_proposal_id, diff.id);

  const topicsResponse = await fetch(`${base}/api/topics`);
  const topics = await topicsResponse.json();
  assert.equal(topicsResponse.status, 200, stderr);
  const retrievalTopic = topics.topics.find((row) => row.topic === "retrieval-test");
  assert.ok(retrievalTopic, "retrieval-test topic should be discoverable");
  assert.ok(retrievalTopic.message_count >= 2);
  assert.ok(retrievalTopic.participant_count >= 2);

  const tieredIdentity = { eigenself: "human/test", slice: "Tiered", instance: "tiered-1" };
  const tieredRoot = await postMessage(base, {
    identity: tieredIdentity, topic: "retrieval-test",
    content: "Root claim for a tiered contestation test.",
  });
  assert.equal(tieredRoot.response.status, 201, stderr);
  const tieredObjection = await postMessage(base, {
    identity: { eigenself: "ai/reviewer", slice: "Reviewer", instance: "reviewer-2" },
    topic: "retrieval-test", message_type: "objection", parent_id: tieredRoot.body.id,
    content: "This is the full, long-form objection with every supporting detail spelled out at length.",
    summary_levels: ["Disputed.", "Disputed: needs qualification.", "Disputed: the claim needs qualification because the supporting evidence is incomplete."],
  });
  assert.equal(tieredObjection.response.status, 201, stderr);
  const objectionId = tieredObjection.body.id;

  const shallow = await (await fetch(`${base}/api/identity-negotiations?instance=tiered-1`)).json();
  assert.equal(shallow.length, 1);
  const shallowContestation = shallow[0].contestations.find((message) => message.id === objectionId);
  assert.equal(shallowContestation.content, "Disputed.");
  assert.equal(shallowContestation.summary_meta.level, 0);
  assert.equal(shallowContestation.summary_meta.max_level, 3);
  assert.equal(shallowContestation.summary_meta.has_more, true);

  const deeper = await (await fetch(`${base}/api/identity-negotiations?instance=tiered-1&detail=1`)).json();
  const deeperContestation = deeper[0].contestations.find((message) => message.id === objectionId);
  assert.equal(deeperContestation.content, "Disputed: needs qualification.");

  const summaryLevel0 = await (await fetch(`${base}/api/messages/${objectionId}/summary`)).json();
  assert.equal(summaryLevel0.level, 0);
  assert.equal(summaryLevel0.is_full, false);
  assert.equal(summaryLevel0.content, "Disputed.");

  const summaryFull = await (await fetch(`${base}/api/messages/${objectionId}/summary?level=99`)).json();
  assert.equal(summaryFull.is_full, true);
  assert.equal(summaryFull.has_more, false);
  assert.match(summaryFull.content, /full, long-form objection/);

  const untieredMessage = await (await fetch(`${base}/api/messages/${first.body.id}/summary`)).json();
  assert.equal(untieredMessage.max_level, 0);
  assert.equal(untieredMessage.is_full, true);
});
