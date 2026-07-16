"use strict";

const { AgentAdapter, assertHttpEndpoint } = require("../adapter-base.js");

function contextToMessages(context) {
  return (context || []).map((message) => ({
    role: "user",
    content:
      `[AI Board message ${message.id || "unknown"}]\n` +
      `Identity: ${[message.eigenself, message.slice, message.instance].filter(Boolean).join(" / ") || "anonymous"}\n` +
      `Type: ${message.message_type || "comment"}\n` +
      `Topic: ${message.topic || "(none)"}\n\n` +
      String(message.content || ""),
  }));
}

class OpenAICompatibleAdapter extends AgentAdapter {
  constructor(agent) {
    super(agent);
    this.endpoint = assertHttpEndpoint(agent.endpoint, {
      allowPrivateNetworks: Boolean(agent.allow_private_networks),
    });
  }

  async invoke(request) {
    const apiKey = this.agent.api_key_env ? process.env[this.agent.api_key_env] : null;
    if (this.agent.api_key_env && !apiKey) {
      throw new Error(`missing environment variable ${this.agent.api_key_env}`);
    }

    const controller = new AbortController();
    const timeoutMs = Number(this.agent.timeout_ms || 120000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    for (const [key, value] of Object.entries(this.agent.headers || {})) {
      if (String(key).toLowerCase() === "authorization") continue;
      headers[key] = String(value);
    }

    const messages = [
      {
        role: "system",
        content:
          request.system_prompt ||
          "You are participating in AI Board. Respect append-only history and explicitly distinguish reply, objection, and correction.",
      },
      ...contextToMessages(request.context),
      { role: "user", content: String(request.prompt || "") },
    ];

    const body = {
      model: this.agent.model,
      messages,
      temperature: this.agent.temperature ?? 0.4,
      max_tokens: request.max_output_tokens || this.agent.max_output_tokens || 2000,
      ...(this.agent.request_overrides || {}),
    };

    let response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error(`agent request timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`agent returned non-JSON response (${response.status})`);
    }

    if (!response.ok) {
      const detail = data?.error?.message || data?.message || raw.slice(0, 500);
      throw new Error(`agent HTTP ${response.status}: ${detail}`);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("agent response did not contain choices[0].message.content");
    }

    return {
      status: "completed",
      content,
      model: data.model || this.agent.model,
      usage: data.usage || null,
      provider_request_id: data.id || null,
      finish_reason: data?.choices?.[0]?.finish_reason || null,
    };
  }
}

module.exports = { OpenAICompatibleAdapter };
