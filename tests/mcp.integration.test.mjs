import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

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

function payload(result) {
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  return JSON.parse(text);
}

test("official MCP stdio client can read, post, search and summon through the HTTP API", async (t) => {
  const port = 24000 + Math.floor(Math.random() * 1000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-mcp-"));
  const board = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AIBOARD_PORT: String(port),
      AIBOARD_DB: path.join(tempDir, "board.db"),
      AIBOARD_ENABLE_MOCK_AGENT: "1",
      AIBOARD_ADMIN_TOKEN: "mcp-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boardStderr = "";
  board.stderr.on("data", (chunk) => { boardStderr += chunk.toString(); });
  t.after(async () => {
    board.kill();
    if (board.exitCode === null && board.signalCode === null) {
      await new Promise((resolve) => { board.once("exit", resolve); setTimeout(resolve, 2000); });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/schema`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp-server.mjs")],
    cwd: root,
    env: {
      ...process.env,
      AIBOARD_URL: base,
      AIBOARD_ADMIN_TOKEN: "mcp-secret",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "ai-board-test-client", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    try { await client.close(); } catch {}
  });

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of ["list_messages", "post_message", "search_messages", "summon_agent", "create_diff_proposal", "export_thread_markdown", "preview_github_issue", "preview_github_draft_pr"]) {
    assert.ok(names.includes(expected), `missing MCP tool ${expected}`);
  }

  const posted = payload(await client.callTool({
    name: "post_message",
    arguments: {
      eigenself: "human/test",
      slice: "MCPTester",
      instance: "mcp-tester-1",
      topic: "mcp-integration",
      content: "MCP persistent assembly verification phrase.",
    },
  }));
  assert.ok(posted.id, boardStderr);

  const search = payload(await client.callTool({
    name: "search_messages",
    arguments: { q: "persistent assembly", topic: "mcp-integration" },
  }));
  assert.ok(search.results.some((message) => message.id === posted.id));

  const summon = payload(await client.callTool({
    name: "summon_agent",
    arguments: {
      agent_ids: ["mock-board-agent"],
      parent_id: posted.id,
      topic: "mcp-integration",
      prompt: "Reply through the MCP summon tool.",
    },
  }));
  assert.ok(summon.id);

  let job;
  for (let i = 0; i < 80; i += 1) {
    job = payload(await client.callTool({ name: "get_summon_status", arguments: { id: summon.id } }));
    if (!["pending", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, "completed", boardStderr);
  assert.equal(job.results.length, 1);

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "aiboard://schema"));
  const schema = await client.readResource({ uri: "aiboard://schema" });
  const schemaText = schema.contents[0].text;
  assert.match(schemaText, /1\.0\.0-rc\.1/);
});
