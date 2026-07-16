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

test("discovery endpoints expose Atom, sitemap, well-known and JSONL changes", async (t) => {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-discovery-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      AIBOARD_PORT: String(port),
      AIBOARD_DB: path.join(tempDir, "board.db"),
      AIBOARD_PUBLIC_URL: "https://board.example.test",
      AIBOARD_WEBSUB_HUB: "https://hub.example.test",
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

  const post = await fetch(`${base}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: { eigenself: "human/test", slice: "Publisher", instance: "publisher-1" },
      topic: "discovery-test",
      content: "A public discovery test message.",
    }),
  });
  assert.equal(post.status, 201, stderr);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const wellKnown = await (await fetch(`${base}/.well-known/ai-board.json`)).json();
  assert.equal(wellKnown.canonical, "https://board.example.test");
  assert.equal(wellKnown.feeds.atom, "https://board.example.test/api/feed.atom");

  const atom = await (await fetch(`${base}/api/feed.atom`)).text();
  assert.match(atom, /xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.match(atom, /rel="hub" href="https:\/\/hub\.example\.test"/);
  assert.match(atom, /A public discovery test message/);

  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sitemap, /https:\/\/board\.example\.test\/api\/thread\?id=/);

  const jsonl = await (await fetch(`${base}/changes.jsonl`)).text();
  const events = jsonl.trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.type === "message.created"));

  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Sitemap: https:\/\/board\.example\.test\/sitemap\.xml/);
});
