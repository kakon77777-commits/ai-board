"use strict";

const crypto = require("node:crypto");

const TIERS = ["registered", "trusted", "admin_bridge"];

const SCOPES = [
  "board:read",
  "message:write",
  "subscription:write",
  "inbox:read",
  "task:submit",
  "artifact:write",
  "moderation:review",
  "admin",
];

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) throw new Error("scopes must be a non-empty array");
  for (const scope of scopes) {
    if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`);
  }
  return [...new Set(scopes)];
}

class TokenService {
  constructor({ db } = {}) {
    if (!db) throw new Error("TokenService requires db");
    this.db = db;
  }

  issue({ label, tier, scopes, expiresAt = null }) {
    if (!label || typeof label !== "string") throw new Error("label is required");
    if (!TIERS.includes(tier)) throw new Error(`tier must be one of: ${TIERS.join(", ")}`);
    const validScopes = validateScopes(scopes);

    const id = crypto.randomUUID();
    const rawToken = `aibt_${crypto.randomBytes(24).toString("base64url")}`;
    const tokenHash = hashToken(rawToken);
    const createdAt = Date.now();

    this.db.prepare(`
      INSERT INTO agent_tokens (id, token_hash, label, tier, scopes_json, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(id, tokenHash, String(label).slice(0, 200), tier, JSON.stringify(validScopes), createdAt, expiresAt);

    // The raw token is returned exactly once; only its hash is ever stored.
    return { id, token: rawToken, label, tier, scopes: validScopes, created_at: createdAt, expires_at: expiresAt };
  }

  verify(rawToken) {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    const row = this.db.prepare("SELECT * FROM agent_tokens WHERE token_hash = ?").get(tokenHash);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && row.expires_at < Date.now()) return null;
    return {
      id: row.id,
      label: row.label,
      tier: row.tier,
      scopes: JSON.parse(row.scopes_json),
    };
  }

  hasScope(verified, scope) {
    return Boolean(verified && Array.isArray(verified.scopes) && verified.scopes.includes(scope));
  }

  revoke(id) {
    const result = this.db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(Date.now(), String(id));
    return result.changes > 0;
  }

  list() {
    return this.db.prepare(`
      SELECT id, label, tier, scopes_json, created_at, expires_at, revoked_at
      FROM agent_tokens ORDER BY created_at DESC
    `).all().map((row) => ({
      id: row.id,
      label: row.label,
      tier: row.tier,
      scopes: JSON.parse(row.scopes_json),
      created_at: row.created_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      active: !row.revoked_at && (!row.expires_at || row.expires_at >= Date.now()),
    }));
  }
}

module.exports = { TokenService, TIERS, SCOPES };
