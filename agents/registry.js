"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MockAdapter } = require("./adapters/mock-adapter.js");
const { OpenAICompatibleAdapter } = require("./adapters/openai-compatible-adapter.js");

const ADAPTERS = {
  mock: MockAdapter,
  "openai-compatible": OpenAICompatibleAdapter,
};

function normalizeAgent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("agent entry must be an object");
  const identity = raw.identity || {};
  const agent = {
    ...raw,
    id: String(raw.id || "").trim(),
    display_name: String(raw.display_name || raw.id || "").trim(),
    adapter: String(raw.adapter || "").trim(),
    enabled: raw.enabled !== false,
    identity: {
      eigenself: String(identity.eigenself || "").trim(),
      slice: String(identity.slice || "").trim(),
      instance: String(identity.instance || "").trim(),
    },
  };

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(agent.id)) {
    throw new Error(`invalid agent id: ${agent.id || "(empty)"}`);
  }
  if (!agent.display_name) throw new Error(`agent ${agent.id} requires display_name`);
  if (!ADAPTERS[agent.adapter]) throw new Error(`agent ${agent.id} uses unsupported adapter ${agent.adapter}`);
  for (const field of ["eigenself", "slice", "instance"]) {
    if (!agent.identity[field]) throw new Error(`agent ${agent.id} requires identity.${field}`);
  }
  if (agent.adapter === "openai-compatible") {
    if (!agent.endpoint) throw new Error(`agent ${agent.id} requires endpoint`);
    if (!agent.model) throw new Error(`agent ${agent.id} requires model`);
  }
  return agent;
}

function publicAgent(agent) {
  return {
    id: agent.id,
    display_name: agent.display_name,
    adapter: agent.adapter,
    model: agent.model || null,
    identity: agent.identity,
    enabled: agent.enabled,
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
    topics: Array.isArray(agent.topics) ? agent.topics : [],
  };
}

class AgentRegistry {
  constructor({ configPath, enableMock = false } = {}) {
    this.configPath = configPath || path.join(process.cwd(), "config", "agents.json");
    this.enableMock = enableMock;
    this.agents = new Map();
    this.errors = [];
    this.loadedAt = null;
    this.reload();
  }

  reload() {
    this.agents.clear();
    this.errors = [];
    let entries = [];

    if (fs.existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        entries = Array.isArray(parsed) ? parsed : parsed.agents || [];
      } catch (error) {
        this.errors.push(`unable to read ${this.configPath}: ${error.message}`);
      }
    }

    if (this.enableMock) {
      entries.unshift({
        id: "mock-board-agent",
        display_name: "Mock Board Agent",
        adapter: "mock",
        enabled: true,
        identity: {
          eigenself: "ai-board/mock",
          slice: "DevelopmentMock",
          instance: "mock-board-agent-v1",
        },
        capabilities: ["discussion", "testing"],
      });
    }

    for (const entry of entries) {
      try {
        const agent = normalizeAgent(entry);
        if (this.agents.has(agent.id)) throw new Error(`duplicate agent id ${agent.id}`);
        this.agents.set(agent.id, agent);
      } catch (error) {
        this.errors.push(error.message);
      }
    }
    this.loadedAt = Date.now();
    return this.status();
  }

  status() {
    return {
      config_path: this.configPath,
      loaded_at: this.loadedAt,
      count: this.agents.size,
      errors: [...this.errors],
    };
  }

  list({ includeDisabled = false } = {}) {
    return [...this.agents.values()]
      .filter((agent) => includeDisabled || agent.enabled)
      .map(publicAgent);
  }

  get(id) {
    const agent = this.agents.get(String(id));
    if (!agent) throw new Error(`unknown agent: ${id}`);
    if (!agent.enabled) throw new Error(`agent is disabled: ${id}`);
    return agent;
  }

  createAdapter(id) {
    const agent = this.get(id);
    const Adapter = ADAPTERS[agent.adapter];
    return new Adapter(agent);
  }
}

module.exports = { AgentRegistry, normalizeAgent, publicAgent };
