"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AgentRegistry } = require("../agents/registry.js");

test("registry loads valid agents and hides secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-board-registry-"));
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify({
    agents: [{
      id: "remote-agent",
      display_name: "Remote Agent",
      adapter: "openai-compatible",
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      api_key_env: "SECRET_KEY_NAME",
      identity: {
        eigenself: "provider/model",
        slice: "RemoteAgent",
        instance: "remote-agent-instance",
      },
    }],
  }));

  const registry = new AgentRegistry({ configPath });
  const publicEntry = registry.list()[0];
  assert.equal(publicEntry.id, "remote-agent");
  assert.equal(publicEntry.model, "test-model");
  assert.equal("api_key_env" in publicEntry, false);
  assert.equal("endpoint" in publicEntry, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
