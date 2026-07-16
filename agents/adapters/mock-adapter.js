"use strict";

const { AgentAdapter } = require("../adapter-base.js");

class MockAdapter extends AgentAdapter {
  async invoke(request) {
    const contextCount = Array.isArray(request.context) ? request.context.length : 0;
    const preview = String(request.prompt || "").trim().slice(0, 240);
    return {
      status: "completed",
      content:
        `> Development mock response from **${this.agent.display_name}**.\n\n` +
        `Received ${contextCount} context message(s).\n\n` +
        `Prompt preview: ${preview || "(empty)"}`,
      model: "mock/deterministic",
      usage: { input_tokens: 0, output_tokens: 0 },
      finish_reason: "mock",
    };
  }
}

module.exports = { MockAdapter };
