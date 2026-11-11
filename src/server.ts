// HTTP + SSE over node:http. Routing and wiring only; the turn itself is in turn.ts.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dayKey, now, setOverride } from "./clock.ts";
import type { LlmProvider } from "./llm/types.ts";
import type { Embedder } from "./memory/embed.ts";
import type { MemoryStore } from "./memory/store.ts";
import { fetchTool } from "./tools/fetch.ts";
import { searchTool } from "./tools/search.ts";
import type { SearchProvider } from "./tools/types.ts";
import { handleTurn, type HandleEvent } from "./turn.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const STATIC: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css" };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const MAX_BODY = 64 * 1024;

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Body must be JSON"); }
}

export function createApp(deps: { provider: LlmProvider; search: SearchProvider; store: MemoryStore; embedder?: Embedder }): Server {
  const { provider, store } = deps;
  const tools = [searchTool(deps.search), fetchTool(deps.search)]; // built once: the fetch cache spans turns
  const busy = new Set<string>();

  async function turn(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    if (!store.getSession(sessionId)) throw new HttpError(404, "Unknown session");
    const { text } = await readJson(req);
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Message text is required");
    if (busy.has(sessionId)) throw new HttpError(409, "A turn is already running in this session");
    busy.add(sessionId);

    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) abort.abort(); });
    const started = Date.now();
    try {
      await handleTurn({ provider, store, tools, embedder: deps.embedder }, sessionId, text.trim(), (e: HandleEvent) => {
        const { type, ...data } = e;
        send(type, data);
      }, abort.signal);
      send("done", { ms: Date.now() - started });
    } catch (e) {
      if (!abort.signal.aborted) console.error("[turn]", e);
      send("error", { message: (e as Error).message || "The turn failed." });
    } finally {
      busy.delete(sessionId);
      res.end();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && STATIC[path]) {
      const file = STATIC[path];
      res.writeHead(200, { "content-type": TYPES[extname(file)], "cache-control": "no-cache" });
      return res.end(await readFile(join(PUBLIC_DIR, file)));
    }
    if (method === "GET" && path === "/api/meta") {
      const n = now();
      return json(res, 200, { today: dayKey(n), nowIso: n.toISOString(), provider: provider.name, model: provider.modelLabel });
    }
    if (path === "/api/sessions") {
      if (method === "GET") return json(res, 200, store.listSessions());
      if (method === "POST") return json(res, 201, await store.createSession({ startedAt: now().toISOString() }));
    }
    const m = /^\/api\/sessions\/([\w-]+)\/(messages|turn)$/.exec(path);
    if (m && method === "GET" && m[2] === "messages") {
      if (!store.getSession(m[1])) throw new HttpError(404, "Unknown session");
      return json(res, 200, store.getMessages(m[1]).map(({ msg, ...rest }) => ({ ...rest, msg: msg.role === "assistant" ? { role: msg.role, parts: msg.parts } : msg })));
    }
    if (m && method === "POST" && m[2] === "turn") return turn(req, res, m[1]);
    if (method === "POST" && path === "/api/clock") {
      // Dev convenience for demos: pretend today is another day. {"now": null} restores the real clock.
      const body = await readJson(req);
      try { setOverride(body.now ?? null); } catch (e) { throw new HttpError(400, (e as Error).message); }
      return json(res, 200, { today: dayKey(now()), nowIso: now().toISOString() });
    }
    throw new HttpError(404, "Not found");
  }

  return createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { error: (e as Error).message });
      else res.end();
    });
  });
}
