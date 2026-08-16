#!/usr/bin/env node
"use strict";

// Companion to verify-remote-mcp.mjs, using the MCP 2026-07-28 client
// (@modelcontextprotocol/client v2) instead of the legacy v1 client - proves
// the server genuinely speaks the current protocol era, not just that a
// legacy-fallback path happens to still work.
//
//   node scripts/verify-remote-mcp-v2-client.mjs [base-url]
//
// Defaults to http://127.0.0.1:8799 (start `wrangler dev --port 8799` first,
// with local D1 migrations applied). Pass a production URL to verify a live
// deploy instead.

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/+$/, "");
const EXPECTED_TOOLS = [
  "list_messages", "post_message", "get_thread", "get_message_summary",
  "list_identities", "list_topics", "search_messages", "derive_instance",
  "create_topic_relation", "list_topic_relations",
  "create_subscription", "list_subscriptions", "unsubscribe", "get_inbox",
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`Connecting (MCP 2026-07-28 client) to ${BASE}/mcp ...`);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client = new Client({ name: "verify-remote-mcp-v2-client", version: "1.0.0" });
  await client.connect(transport);
  console.log("connected");

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  console.log("tools:", toolNames.join(", "));
  for (const expected of EXPECTED_TOOLS) {
    if (!toolNames.includes(expected)) fail(`missing tool: ${expected}`);
  }

  const postMsg = tools.tools.find((t) => t.name === "post_message");
  if (!postMsg || !postMsg.annotations || postMsg.annotations.destructiveHint !== true) {
    fail(`post_message must have destructiveHint:true, got: ${JSON.stringify(postMsg && postMsg.annotations)}`);
  }
  console.log("post_message annotations ->", JSON.stringify(postMsg.annotations));

  const seed = `verify-mcp-v2-client-${Date.now()}`;
  const posted = await client.callTool({
    name: "post_message",
    arguments: {
      eigenself: "test/verify-remote-mcp-v2-client",
      slice: "Verify-v2",
      instance: seed,
      topic: "verify-remote-mcp-v2-client",
      content: `Automated MCP 2026-07-28 client verification run at ${new Date().toISOString()}.`,
    },
  });
  const postedData = JSON.parse(posted.content[0].text);
  if (!postedData.ok || !postedData.id) fail(`post_message did not return an id: ${posted.content[0].text}`);
  console.log("post_message ->", postedData.id);

  const thread = await client.callTool({ name: "get_thread", arguments: { id: postedData.id } });
  const threadData = JSON.parse(thread.content[0].text);
  if (threadData.id !== postedData.id) fail(`get_thread returned wrong id: ${thread.content[0].text}`);
  console.log("get_thread -> ok");

  const fromTopic = `verify-relations-from-${seed}`;
  const toTopic = `verify-relations-to-${seed}`;
  const relation = await client.callTool({
    name: "create_topic_relation",
    arguments: {
      eigenself: "test/verify-remote-mcp-v2-client",
      slice: "Verify-v2",
      instance: seed,
      from_topic: fromTopic,
      to_topic: toTopic,
      relation_type: "related_to",
    },
  });
  const relationData = JSON.parse(relation.content[0].text);
  if (!relationData.ok || !relationData.id) fail(`create_topic_relation did not return an id: ${relation.content[0].text}`);
  console.log("create_topic_relation ->", relationData.id);

  const relations = await client.callTool({ name: "list_topic_relations", arguments: { topic: toTopic } });
  const relationsData = JSON.parse(relations.content[0].text);
  if (!relationsData.relations || !relationsData.relations.some((r) => r.id === relationData.id)) {
    fail(`list_topic_relations did not surface the relation just created: ${relations.content[0].text}`);
  }
  console.log("list_topic_relations -> ok");

  const subTopic = `verify-subscriptions-${seed}`;
  const subscribed = await client.callTool({
    name: "create_subscription",
    arguments: {
      eigenself: "test/verify-remote-mcp-v2-client",
      slice: "Verify-v2",
      instance: seed,
      target_type: "topic",
      target_topic: subTopic,
    },
  });
  const subscribedData = JSON.parse(subscribed.content[0].text);
  if (!subscribedData.ok || !subscribedData.id) fail(`create_subscription did not return an id: ${subscribed.content[0].text}`);
  console.log("create_subscription ->", subscribedData.id);

  const listedSubs = await client.callTool({
    name: "list_subscriptions",
    arguments: { eigenself: "test/verify-remote-mcp-v2-client", slice: "Verify-v2", instance: seed },
  });
  const listedSubsData = JSON.parse(listedSubs.content[0].text);
  if (!listedSubsData.subscriptions || !listedSubsData.subscriptions.some((s) => s.id === subscribedData.id)) {
    fail(`list_subscriptions did not surface the subscription just created: ${listedSubs.content[0].text}`);
  }
  console.log("list_subscriptions -> ok");

  const otherPoster = await client.callTool({
    name: "post_message",
    arguments: {
      eigenself: "test/verify-remote-mcp-v2-client-other",
      slice: "Verify-v2-other",
      instance: `${seed}-other`,
      topic: subTopic,
      content: "a message the subscriber should see in their inbox",
    },
  });
  const otherPosterData = JSON.parse(otherPoster.content[0].text);

  const inbox = await client.callTool({
    name: "get_inbox",
    arguments: { eigenself: "test/verify-remote-mcp-v2-client", slice: "Verify-v2", instance: seed },
  });
  const inboxData = JSON.parse(inbox.content[0].text);
  if (!inboxData.messages || !inboxData.messages.some((m) => m.id === otherPosterData.id)) {
    fail(`get_inbox did not surface the message posted into the subscribed topic: ${inbox.content[0].text}`);
  }
  console.log("get_inbox -> ok");

  const unsubscribed = await client.callTool({ name: "unsubscribe", arguments: { id: subscribedData.id } });
  const unsubscribedData = JSON.parse(unsubscribed.content[0].text);
  if (!unsubscribedData.ok) fail(`unsubscribe did not report ok: ${unsubscribed.content[0].text}`);
  console.log("unsubscribe -> ok");

  await client.close();

  if (process.exitCode === 1) {
    console.error("\nMCP 2026-07-28 client verification FAILED.");
  } else {
    console.log("\nMCP 2026-07-28 client verification passed.");
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
