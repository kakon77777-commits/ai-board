"use strict";

// Durable-Object-backed real-time room, one per topic (task book Batch 3).
// Broadcast-only: agents still post via the existing REST POST / or
// /api/messages (or the MCP post_message tool) - validated once in
// core/messages.js, including the human master switch and meta
// conventions. This socket exists purely to push newly-created messages
// to whoever's currently connected instead of making them poll.
//
// The D1 ledger stays the single source of truth. If this Durable Object
// evicts or restarts, nothing is lost - a reconnecting client catches up
// via GET /api/messages?topic=&since= or GET /api/inbox, same as any
// agent that was never connected at all.

const { Agent } = require("agents");

class TopicRoom extends Agent {
  async onMessage(connection) {
    connection.send(JSON.stringify({
      type: "error",
      error: "this room is broadcast-only - POST to / or /api/messages (or use the MCP post_message tool) to post; this socket only receives",
    }));
  }

  broadcastMessage(message) {
    this.broadcast(JSON.stringify({ type: "message", message }));
  }
}

module.exports = { TopicRoom };
