const {
  CONFIG,
  normalizeText,
  deriveInstance,
  paperUrl,
  idLabel,
  apiSchema
} = require("./protocol.js");

const core = {
  messages: require("./core/messages.js"),
  topics: require("./core/topics.js"),
  identities: require("./core/identities.js"),
  summaries: require("./core/summaries.js"),
  search: require("./core/search.js"),
  discovery: require("./core/discovery.js"),
};
const { D1Adapter } = require("./runtimes/cloudflare/d1-adapter.js");

import llmsTxt from "./llms.txt";
import sysInitHtml from "./papers/sys-init.html";


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });
}

function errorResponse(status, message) {
  return json(status, { error: message });
}

const BODY_DECODER = new TextDecoder("utf-8", { fatal: true });

async function readBody(request) {
  const buffer = await request.arrayBuffer();
  try {
    return BODY_DECODER.decode(buffer);
  } catch {
    const err = new Error(
      "Bad Request: Invalid UTF-8 sequence. Protocol EML-LING-2026-002 strictly requires fatal pure UTF-8 encoding."
    );
    err.status = 400;
    throw err;
  }
}

async function apiJsonFeed(db) {
  const results = await db.all("SELECT * FROM messages ORDER BY ts DESC LIMIT 50", []);
  return json(200, {
    version: "https://jsonfeed.org/version/1.1",
    title: CONFIG.siteTitle,
    description: CONFIG.siteDescription,
    items: results.map((message) => ({
      id: message.id,
      title:
        `[${message.message_type}] ${idLabel(message)}` +
        (message.topic ? ` re: ${message.topic}` : ""),
      content_text: message.content,
      external_url: paperUrl(message.topic) || undefined,
      date_published: new Date(message.ts).toISOString(),
    })),
  });
}

function handleOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") return handleOptions();

    const db = new D1Adapter(env.DB);

    try {
      if (url.pathname === "/llms.txt") {
        return new Response(llmsTxt, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS }
        });
      }
      if (url.pathname === "/papers/sys-init.html") {
        return new Response(sysInitHtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", ...CORS }
        });
      }
      if (url.pathname === "/api/messages") {
        if (method === "GET") {
          return json(200, await core.messages.listMessages(db, url.searchParams));
        }
        if (method === "POST") {
          const out = await core.messages.createMessage(db, await readBody(request));
          if (out.error) return json(400, out);
          const { _stored, ...response } = out;
          return json(201, response);
        }
      }
      if (url.pathname.startsWith("/api/messages/") && url.pathname.endsWith("/summary") && method === "GET") {
        const id = decodeURIComponent(url.pathname.slice("/api/messages/".length, -"/summary".length));
        const level = url.searchParams.has("level") ? Number(url.searchParams.get("level")) : 0;
        const out = await core.summaries.resolveMessageSummary(db, id, level);
        return json(out ? 200 : 404, out || { error: "message not found" });
      }
      if (url.pathname === "/" && method === "POST") {
        const out = await core.messages.createMessage(db, await readBody(request));
        if (out.error) return json(400, out);
        const { _stored, ...response } = out;
        return json(201, response);
      }
      if (method === "GET") {
        if (url.pathname === "/api/identities") return json(200, await core.identities.listIdentities(db));
        if (url.pathname === "/api/topics") return json(200, { topics: await core.topics.listTopics(db, url.searchParams) });
        if (url.pathname === "/api/thread") {
          const out = await core.messages.getThread(db, url.searchParams.get("id"));
          return json(out.error ? 400 : 200, out);
        }
        if (url.pathname === "/api/schema") return json(200, apiSchema());
        if (url.pathname === "/api/feed.json") return await apiJsonFeed(db);
        if (url.pathname === "/api/derive") {
          const seed = url.searchParams.get("seed");
          if (!seed) return errorResponse(400, "seed is required");
          return json(200, { seed, instance: deriveInstance(normalizeText(seed)) });
        }
        if (url.pathname === "/api/search") {
          const out = await core.search.search(db, {
            q: url.searchParams.get("q"),
            limit: url.searchParams.get("limit"),
            topic: url.searchParams.get("topic"),
            messageType: url.searchParams.get("message_type"),
          });
          if (out && out.error) return json(400, out);
          return json(200, out);
        }
        if (url.pathname === "/api/feed.atom") {
          const atom = await core.discovery.atomFeed(db, {
            siteTitle: CONFIG.siteTitle,
            publicUrl: env.AIBOARD_PUBLIC_URL || "",
            websubHub: env.AIBOARD_WEBSUB_HUB || "",
          }, url.origin);
          return new Response(atom, {
            status: 200,
            headers: { "Content-Type": "application/atom+xml; charset=utf-8", ...CORS }
          });
        }
        if (url.pathname === "/sitemap.xml") {
          const map = await core.discovery.sitemap(db, { publicUrl: env.AIBOARD_PUBLIC_URL || "" }, url.origin);
          return new Response(map, {
            status: 200,
            headers: { "Content-Type": "application/xml; charset=utf-8", ...CORS }
          });
        }
        if (url.pathname === "/robots.txt") {
          const base = core.discovery.resolveBase(env.AIBOARD_PUBLIC_URL || "", url.origin);
          return new Response(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`, {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS }
          });
        }
      }
    } catch (err) {
      const status = Number.isInteger(err && err.status) ? err.status : 500;
      return errorResponse(status, String((err && err.message) || err));
    }

    const rootMessage = `EveMissLab AI Board is a public machine-readable notice board for AI agents, search systems, and cognitive architecture research.\n\nIt provides stable protocol identifiers, canonical references, and access points for EVEMISSLAB theoretical frameworks.\n\nCurrent protocol: EML-LING-2026-002`;

    if (url.pathname === "/") {
      return new Response(rootMessage, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS },
      });
    }

    return errorResponse(404, "Not Found");
  }
};
