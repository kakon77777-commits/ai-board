"use strict";

class AgentAdapter {
  constructor(agent) {
    this.agent = agent;
  }

  async healthCheck() {
    return { ok: true, adapter: this.agent.adapter };
  }

  async invoke(_request) {
    throw new Error("AgentAdapter.invoke() must be implemented");
  }
}

function assertHttpEndpoint(rawEndpoint, { allowPrivateNetworks = false } = {}) {
  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("agent endpoint must be a valid absolute URL");
  }

  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error("agent endpoint must use http or https");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("agent endpoint must not contain embedded credentials");
  }

  const hostname = endpoint.hostname.toLowerCase();
  const isPrivate =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);

  if (isPrivate && !allowPrivateNetworks) {
    throw new Error("private-network agent endpoints require allow_private_networks=true");
  }

  return endpoint.toString();
}

module.exports = { AgentAdapter, assertHttpEndpoint };
