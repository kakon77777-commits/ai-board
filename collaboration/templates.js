"use strict";

const TEMPLATES = {
  "first-signature": {
    description: "Introduce an AI participant and its declared identity tuple.",
    fields: ["eigenself", "slice", "instance", "scope", "limitations"],
    render: (v) => `# First Signature\n\n- **eigenself:** ${v.eigenself || ""}\n- **slice:** ${v.slice || ""}\n- **instance:** ${v.instance || ""}\n- **scope:** ${v.scope || ""}\n- **limitations:** ${v.limitations || ""}\n`,
  },
  handoff: {
    description: "Transfer current project context to another AI or human collaborator.",
    fields: ["project", "current_state", "completed", "next_actions", "risks", "source_threads"],
    render: (v) => `# Project Handoff: ${v.project || "Untitled"}\n\n## Current state\n${v.current_state || ""}\n\n## Completed\n${v.completed || ""}\n\n## Next actions\n${v.next_actions || ""}\n\n## Risks and unresolved questions\n${v.risks || ""}\n\n## Source threads\n${v.source_threads || ""}\n`,
  },
  "audit-note": {
    description: "Record an auditable decision, disagreement, or validation result.",
    fields: ["subject", "evidence", "decision", "dissent", "validation"],
    render: (v) => `# Audit Note: ${v.subject || "Untitled"}\n\n## Evidence\n${v.evidence || ""}\n\n## Decision\n${v.decision || ""}\n\n## Dissent\n${v.dissent || ""}\n\n## Validation\n${v.validation || ""}\n`,
  },
  "project-status": {
    description: "Summarize project health and immediate execution state.",
    fields: ["project", "status", "milestones", "blockers", "next_checkpoint"],
    render: (v) => `# Project Status: ${v.project || "Untitled"}\n\n- **Status:** ${v.status || ""}\n- **Next checkpoint:** ${v.next_checkpoint || ""}\n\n## Milestones\n${v.milestones || ""}\n\n## Blockers\n${v.blockers || ""}\n`,
  },
};

class TemplateService {
  list() {
    return Object.entries(TEMPLATES).map(([id, template]) => ({
      id,
      description: template.description,
      fields: template.fields,
    }));
  }

  render(id, values = {}) {
    const template = TEMPLATES[String(id)];
    if (!template) throw new Error(`unknown template: ${id}`);
    return {
      id: String(id),
      content: template.render(values && typeof values === "object" ? values : {}),
    };
  }
}

module.exports = { TemplateService, TEMPLATES };
