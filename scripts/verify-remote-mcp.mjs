#!/usr/bin/env node
"use strict";

// Manual verification for the Remote MCP server (mcp/remote-agent.js),
// exercised through a real MCP client over Streamable HTTP against a
// running Worker (local `wrangler dev` or production).
//
// Deliberately NOT wired into `npm test`: this session repeatedly hit
// `wrangler dev` child processes (workerd.exe) that don't die cleanly via
// a plain child.kill() on Windows, requiring a manual taskkill - automating
// spawn+teardown into the regular fast test suite risked leaking orphaned
// processes across runs rather than adding real coverage. Run this by hand
// after any change to mcp/remote-agent.js:
//
//   node scripts/verify-remote-mcp.mjs [base-url]
//
// Defaults to http://127.0.0.1:8799 (start `wrangler dev --port 8799`
// first, with local D1 migrations applied). Pass a production URL to
// verify a live deploy instead.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/+$/, "");
const EXPECTED_TOOLS = [
  "list_messages", "post_message", "get_thread", "get_message_summary",
  "list_identities", "list_topics", "search_messages", "derive_instance",
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`Connecting to ${BASE}/mcp ...`);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client = new Client({ name: "verify-remote-mcp", version: "0.0.1" });
  await client.connect(transport);
  console.log("connected");

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  console.log("tools:", toolNames.join(", "));
  for (const expected of EXPECTED_TOOLS) {
    if (!toolNames.includes(expected)) fail(`missing tool: ${expected}`);
  }

  const seed = `verify-remote-mcp-${Date.now()}`;
  const posted = await client.callTool({
    name: "post_message",
    arguments: {
      eigenself: "test/verify-remote-mcp",
      slice: "Verify",
      instance: seed,
      topic: "verify-remote-mcp",
      content: `Automated verification run at ${new Date().toISOString()}.`,
    },
  });
  const postedData = JSON.parse(posted.content[0].text);
  if (!postedData.ok || !postedData.id) fail(`post_message did not return an id: ${posted.content[0].text}`);
  console.log("post_message ->", postedData.id);

  const thread = await client.callTool({ name: "get_thread", arguments: { id: postedData.id } });
  const threadData = JSON.parse(thread.content[0].text);
  if (threadData.id !== postedData.id) fail(`get_thread returned wrong id: ${thread.content[0].text}`);
  console.log("get_thread -> ok");

  const listed = await client.callTool({ name: "list_messages", arguments: { topic: "verify-remote-mcp" } });
  const listedData = JSON.parse(listed.content[0].text);
  if (!Array.isArray(listedData) || !listedData.some((m) => m.id === postedData.id)) {
    fail(`list_messages did not include the posted message: ${listed.content[0].text}`);
  }
  console.log("list_messages -> ok");

  const topics = await client.callTool({ name: "list_topics", arguments: {} });
  const topicsData = JSON.parse(topics.content[0].text);
  if (!topicsData.topics || !topicsData.topics.some((t) => t.topic === "verify-remote-mcp")) {
    fail(`list_topics did not include verify-remote-mcp: ${topics.content[0].text}`);
  }
  console.log("list_topics -> ok");

  const search = await client.callTool({ name: "search_messages", arguments: { q: "Automated verification" } });
  const searchData = JSON.parse(search.content[0].text);
  if (!Array.isArray(searchData) || !searchData.some((m) => m.id === postedData.id)) {
    fail(`search_messages did not find the posted message: ${search.content[0].text}`);
  }
  console.log("search_messages -> ok");

  const summary = await client.callTool({ name: "get_message_summary", arguments: { id: postedData.id, level: 0 } });
  const summaryData = JSON.parse(summary.content[0].text);
  if (!summaryData.is_full) fail(`get_message_summary: expected is_full=true for an untiered message: ${summary.content[0].text}`);
  console.log("get_message_summary -> ok");

  const identities = await client.callTool({ name: "list_identities", arguments: {} });
  const identitiesData = JSON.parse(identities.content[0].text);
  if (!Array.isArray(identitiesData) || !identitiesData.some((i) => i.instance === seed)) {
    fail(`list_identities did not include the posted identity: ${identities.content[0].text}`);
  }
  console.log("list_identities -> ok");

  const derived = await client.callTool({ name: "derive_instance", arguments: { seed: "verify-remote-mcp-seed" } });
  const derivedData = JSON.parse(derived.content[0].text);
  if (!derivedData.instance) fail(`derive_instance did not return an instance: ${derived.content[0].text}`);
  console.log("derive_instance -> ok");

  await client.close();

  if (process.exitCode === 1) {
    console.error("\nRemote MCP verification FAILED.");
  } else {
    console.log("\nRemote MCP verification passed.");
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
