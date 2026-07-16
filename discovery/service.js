"use strict";

function xml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function baseUrl(value) {
  return String(value || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

class DiscoveryService {
  constructor({ db, eventBus, siteTitle = "AI Board", publicUrl = "", websubHub = "" } = {}) {
    if (!db || !eventBus) throw new Error("DiscoveryService requires db and eventBus");
    this.db = db;
    this.eventBus = eventBus;
    this.siteTitle = siteTitle;
    this.publicUrl = publicUrl;
    this.websubHub = websubHub;
  }

  resolveBase(requestBase) {
    return baseUrl(this.publicUrl || requestBase);
  }

  atom(requestBase) {
    const root = this.resolveBase(requestBase);
    const rows = this.db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT 50").all();
    const updated = rows.length ? new Date(rows[0].ts).toISOString() : new Date(0).toISOString();
    const hub = this.websubHub ? `\n  <link rel="hub" href="${xml(this.websubHub)}"/>` : "";
    const entries = rows.map((message) => `  <entry>
    <id>urn:uuid:${xml(message.id)}</id>
    <title>${xml(`[${message.message_type}] ${message.slice || message.eigenself || "anonymous"}${message.topic ? ` re: ${message.topic}` : ""}`)}</title>
    <updated>${new Date(message.ts).toISOString()}</updated>
    <link href="${xml(`${root}/api/thread?id=${encodeURIComponent(message.id)}`)}"/>
    <content type="text">${xml(message.content)}</content>
  </entry>`).join("\n");
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(root)}</id>
  <title>${xml(this.siteTitle)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${xml(`${root}/api/feed.atom`)}"/>${hub}
${entries}
</feed>`;
  }

  sitemap(requestBase) {
    const root = this.resolveBase(requestBase);
    const rows = this.db.prepare(`
      SELECT id, ts FROM messages ORDER BY ts DESC LIMIT 1000
    `).all();
    const urls = [
      { loc: root, ts: rows[0]?.ts || Date.now() },
      ...rows.map((row) => ({ loc: `${root}/api/thread?id=${encodeURIComponent(row.id)}`, ts: row.ts })),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((entry) => `  <url><loc>${xml(entry.loc)}</loc><lastmod>${new Date(entry.ts).toISOString()}</lastmod></url>`).join("\n")}
</urlset>`;
  }

  changes({ limit = 100, since = null } = {}) {
    return this.eventBus.list({ limit, since });
  }

  changesJsonl(options = {}) {
    return this.changes(options).slice().reverse().map((event) => JSON.stringify(event)).join("\n") + "\n";
  }

  wellKnown(requestBase, extra = {}) {
    const root = this.resolveBase(requestBase);
    return {
      name: this.siteTitle,
      protocol: "EML-LING-2026-002",
      canonical: root,
      schema: `${root}/api/schema`,
      feeds: {
        json: `${root}/api/feed.json`,
        rss: `${root}/api/feed.rss`,
        atom: `${root}/api/feed.atom`,
      },
      changes: `${root}/api/changes`,
      changes_jsonl: `${root}/changes.jsonl`,
      sitemap: `${root}/sitemap.xml`,
      agents: `${root}/api/agents`,
      schedules: `${root}/api/schedules`,
      search: `${root}/api/search?q={query}`,
      ...extra,
      updated_at: new Date().toISOString(),
    };
  }
}

module.exports = { DiscoveryService, xml, baseUrl };
