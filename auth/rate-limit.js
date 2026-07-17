"use strict";

const crypto = require("node:crypto");

// In-memory fixed-window limiter. Fine for the local single-process
// server; a Cloudflare deployment will need a Durable Object or KV-backed
// equivalent (out of scope until the domain-core/runtime split happens).
class RateLimiter {
  constructor({ windows = [] } = {}) {
    // windows: [{ id, limit, windowMs }, ...] - a request must pass every window.
    this.windows = windows;
    this.buckets = new Map(); // key -> { windowId -> { count, resetAt } }
  }

  key({ tokenId, agentId, ip, endpoint }) {
    const ipHash = ip ? crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16) : "no-ip";
    return `${tokenId || "anon"}:${agentId || "unknown"}:${ipHash}:${endpoint}`;
  }

  check(identity) {
    const key = this.key(identity);
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {};
      this.buckets.set(key, bucket);
    }
    for (const w of this.windows) {
      let entry = bucket[w.id];
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + w.windowMs };
        bucket[w.id] = entry;
      }
      if (entry.count >= w.limit) {
        return { allowed: false, window: w.id, limit: w.limit, retry_after_ms: entry.resetAt - now };
      }
    }
    for (const w of this.windows) bucket[w.id].count += 1;
    return { allowed: true };
  }

  // Periodic cleanup so long-running processes don't accumulate stale keys forever.
  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      const stillLive = Object.values(bucket).some((entry) => entry.resetAt > now);
      if (!stillLive) this.buckets.delete(key);
    }
  }
}

module.exports = { RateLimiter };
