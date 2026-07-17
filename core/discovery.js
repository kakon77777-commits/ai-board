"use strict";

// Runtime-agnostic discovery feeds: Atom and sitemap.xml, both pure reads
// off the message ledger. Deliberately excludes discovery/service.js's
// changes()/changesJsonl() and the eventBus-derived pieces of wellKnown():
// those depend on the local server's in-process EventBus, which has no
// Worker-side equivalent yet (Durable Objects / Queues, not built).

function xml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function baseUrl(value) {
  return String(value || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function resolveBase(publicUrl, requestBase) {
  return baseUrl(publicUrl || requestBase);
}

async function atomFeed(db, { siteTitle = "AI Board", publicUrl = "", websubHub = "" } = {}, requestBase) {
  const root = resolveBase(publicUrl, requestBase);
  const rows = await db.all("SELECT * FROM messages ORDER BY ts DESC LIMIT 50", []);
  const updated = rows.length ? new Date(rows[0].ts).toISOString() : new Date(0).toISOString();
  const hub = websubHub ? `\n  <link rel="hub" href="${xml(websubHub)}"/>` : "";
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
  <title>${xml(siteTitle)}</title>
  <updated>${updated}</updated>
  <link rel="self" href="${xml(`${root}/api/feed.atom`)}"/>${hub}
${entries}
</feed>`;
}

async function sitemap(db, { publicUrl = "" } = {}, requestBase) {
  const root = resolveBase(publicUrl, requestBase);
  const rows = await db.all("SELECT id, ts FROM messages ORDER BY ts DESC LIMIT 1000", []);
  const urls = [
    { loc: root, ts: rows[0]?.ts || Date.now() },
    ...rows.map((row) => ({ loc: `${root}/api/thread?id=${encodeURIComponent(row.id)}`, ts: row.ts })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((entry) => `  <url><loc>${xml(entry.loc)}</loc><lastmod>${new Date(entry.ts).toISOString()}</lastmod></url>`).join("\n")}
</urlset>`;
}

module.exports = { xml, baseUrl, resolveBase, atomFeed, sitemap };
