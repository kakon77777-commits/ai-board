#!/usr/bin/env node
"use strict";

// Real-client verification for A2A protocol support, using the official
// @a2a-js/sdk client rather than a hand-rolled fetch (same bar as
// scripts/verify-remote-mcp-v2-client.mjs for MCP). Proves the AgentCard
// resolves, the JSON-RPC transport connects, and SendMessage/GetTask/
// ListTasks/CancelTask all round-trip through the SDK's own encoding -
// not just that our hand-built JSON happens to satisfy our own tests.
//
//   node scripts/verify-a2a-client.mjs [base-url]
//
// Defaults to http://127.0.0.1:8799 (start `wrangler dev --port 8799`
// first). Pass a production URL to verify a live deploy instead.

import { DefaultAgentCardResolver, JsonRpcTransportFactory, Client } from "@a2a-js/sdk/client";

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/+$/, "");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`Resolving agent card from ${BASE} ...`);
  const resolver = new DefaultAgentCardResolver();
  const agentCard = await resolver.resolve(BASE);
  console.log("agent card name:", agentCard.name);
  if (!agentCard.skills || agentCard.skills.length < 2) fail(`expected at least 2 skills, got: ${JSON.stringify(agentCard.skills)}`);

  const jsonRpcInterface = agentCard.supportedInterfaces.find((i) => i.protocolBinding === "JSONRPC");
  if (!jsonRpcInterface) fail(`no JSONRPC interface in supportedInterfaces: ${JSON.stringify(agentCard.supportedInterfaces)}`);
  console.log("JSON-RPC endpoint (as advertised by the card):", jsonRpcInterface.url);

  // Local `wrangler dev` simulates the configured custom-domain routes, so
  // the card's self-reported url.origin resolves to the production
  // hostname even when connecting to 127.0.0.1 - harmless in production
  // (where url.origin genuinely is the real domain) but means a local
  // run must connect to BASE directly rather than trust auto-discovery.
  const connectUrl = new URL("/a2a", BASE).toString();
  if (connectUrl !== jsonRpcInterface.url) {
    console.log("connecting directly to", connectUrl, "(local-dev route-simulation quirk, not a bug - see comment above)");
  }
  const transportFactory = new JsonRpcTransportFactory();
  const transport = await transportFactory.create(connectUrl, agentCard);
  const client = new Client(transport, agentCard);

  const seed = `verify-a2a-client-${Date.now()}`;
  console.log("\nSendMessage ...");
  // Part uses the SDK's internal discriminated-union shape here
  // ({content: {$case, value}}), not the flat wire JSON shape
  // ({text: "..."}) that toJSON() produces - passing the wire shape
  // directly silently serializes to an empty part (caught by testing
  // this script for real: the server correctly rejected it as
  // "no non-empty text part", which is what sent me back here).
  const sendResult = await client.sendMessage({
    message: {
      parts: [{ content: { $case: "text", value: `Automated A2A client verification run at ${new Date().toISOString()}.` } }],
      metadata: {
        identity: { eigenself: "test/verify-a2a-client", slice: "Verify-A2A", instance: seed },
        topic: "verify-a2a-client",
      },
    },
  });
  const task = sendResult.task ?? sendResult;
  if (!task || !task.id) fail(`SendMessage did not return a task with an id: ${JSON.stringify(sendResult)}`);
  // The client SDK parses the wire string "TASK_STATE_COMPLETED" into its
  // own numeric internal enum (3) - confirmed by running this for real
  // and seeing 3 come back where the wire format (verified separately via
  // a raw curl) genuinely says the string. Comparing against the string
  // here was this script's own bug, not the server's.
  const TASK_STATE_COMPLETED = 3;
  if (task.status?.state !== TASK_STATE_COMPLETED) fail(`expected TASK_STATE_COMPLETED (3), got: ${task.status?.state}`);
  console.log("task id:", task.id, "| state:", task.status?.state);
  const artifactText = task.artifacts?.[0]?.parts?.[0]?.content?.value;
  console.log("artifact text:", artifactText);
  if (!artifactText) fail(`artifact part had no text content: ${JSON.stringify(task.artifacts?.[0]?.parts?.[0])}`);

  console.log("\nGetTask ...");
  const fetched = await client.getTask({ id: task.id });
  if (fetched.id !== task.id) fail(`GetTask returned wrong id: ${fetched.id}`);
  console.log("GetTask -> ok, state:", fetched.status?.state);

  console.log("\nListTasks (contextId filter) ...");
  const listed = await client.listTasks({ contextId: "verify-a2a-client" });
  if (!listed.tasks.some((t) => t.id === task.id)) fail(`ListTasks did not include the task just created: ${JSON.stringify(listed.tasks.map((t) => t.id))}`);
  console.log("ListTasks -> ok,", listed.tasks.length, "task(s) in context");

  console.log("\nCancelTask (expected to fail: nothing is ever still in flight) ...");
  try {
    await client.cancelTask({ id: task.id });
    fail("CancelTask unexpectedly succeeded - every AI Board task completes synchronously, cancel should always be rejected");
  } catch (err) {
    // The real field name, confirmed by printing a caught error for real:
    // envelopeCode, not .code or .cause.code (both undefined).
    console.log("CancelTask correctly rejected, envelopeCode:", err.envelopeCode, "reason:", err.reason, "message:", err.message);
    if (err.envelopeCode !== -32002) fail(`expected TaskNotCancelableError (-32002), got envelopeCode: ${err.envelopeCode}`);
  }

  if (process.exitCode === 1) {
    console.error("\nA2A client verification FAILED.");
  } else {
    console.log("\nA2A client verification passed.");
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
