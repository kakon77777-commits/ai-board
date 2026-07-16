"use strict";

function parseJson(value, fallback = {}) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sameIdentity(message, agent) {
  return Boolean(
    message && agent &&
    message.eigenself === agent.identity.eigenself &&
    message.slice === agent.identity.slice &&
    message.instance === agent.identity.instance
  );
}

function extractMentionIds(content) {
  const mentions = new Set();
  const text = String(content || "");
  const regex = /(^|[\s([{])@([A-Za-z0-9][A-Za-z0-9._-]{1,99}|all)\b/g;
  let match;
  while ((match = regex.exec(text))) mentions.add(match[2]);
  return [...mentions];
}

class TriggerEngine {
  constructor({ eventBus, summonService, registry, maxCascadeDepth = 2, cooldownMs = 300000 } = {}) {
    if (!eventBus || !summonService || !registry) throw new Error("TriggerEngine requires eventBus, summonService and registry");
    this.eventBus = eventBus;
    this.summonService = summonService;
    this.registry = registry;
    this.maxCascadeDepth = Math.max(0, Number(maxCascadeDepth) || 0);
    this.cooldownMs = Math.max(1000, Number(cooldownMs) || 300000);
    this.unsubscribe = eventBus.on("message.created", "mention-summon", (event) => this.handleMessage(event));
  }

  stop() {
    if (this.unsubscribe) this.unsubscribe();
  }

  handleMessage(event) {
    const message = event?.payload?.message;
    if (!message) return { status: "skipped", reason: "message missing" };
    const mentionIds = extractMentionIds(message.content);
    if (!mentionIds.length) return { status: "skipped", reason: "no mentions" };

    const meta = parseJson(message.meta, {});
    const currentDepth = Math.max(0, Number(meta.summon_cascade_depth || 0));
    if (currentDepth >= this.maxCascadeDepth) {
      return { status: "skipped", reason: "cascade depth limit", current_depth: currentDepth };
    }

    let agents;
    if (mentionIds.includes("all")) {
      agents = this.registry.list().map((entry) => this.registry.get(entry.id));
    } else {
      agents = mentionIds.map((id) => {
        try { return this.registry.get(id); } catch { return null; }
      }).filter(Boolean);
    }
    agents = agents.filter((agent) => !sameIdentity(message, agent));
    if (!agents.length) return { status: "skipped", reason: "no eligible mentioned agents" };

    const agentIds = [...new Set(agents.map((agent) => agent.id))].sort();
    const job = this.summonService.create({
      agent_ids: agentIds,
      topic: message.topic || null,
      parent_id: message.id,
      trigger_type: "mention",
      prompt:
        "You were explicitly mentioned in an AI Board message. Read the target message and relevant thread context, " +
        "then provide a substantive reply. Do not repeat the mention merely to summon another agent. State disagreement or uncertainty explicitly.",
      budget: { max_output_tokens: 2000 },
    }, {
      dedupKey: `mention:${message.id}:${agentIds.join(",")}`,
      sourceEventId: event.id,
      cascadeDepth: currentDepth + 1,
      cooldownMs: this.cooldownMs,
    });

    return {
      status: job.deduplicated ? "skipped" : "completed",
      reason: job.deduplicated ? "deduplicated" : undefined,
      job_id: job.id,
      agent_ids: agentIds,
      cascade_depth: currentDepth + 1,
    };
  }
}

module.exports = { TriggerEngine, extractMentionIds, sameIdentity };
