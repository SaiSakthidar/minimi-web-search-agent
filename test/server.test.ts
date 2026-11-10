import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setOverride } from "../src/clock.ts";
import { selectProvider } from "../src/llm/select.ts";
import { awaitExtractions } from "../src/memory/extract.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createApp } from "../src/server.ts";
import type { SearchProvider } from "../src/tools/types.ts";
import { fakeProvider, type Scripted } from "./helpers/fakeProvider.ts";

let dir: string;
let server: Server;
let base: string;
let store: MemoryStore;

const search: SearchProvider = {
  async search() { return [{ title: "Neon pricing", url: "https://neon.tech/pricing", publishedDate: "2026-11-07", highlights: ["Launch $24/mo"] }]; },
  async contents() { return null; },
};

async function start(script: Scripted[]) {
  const provider = fakeProvider(script);
  server = createApp({ provider, search, store });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return provider;
}

async function sse(path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text.split("\n\n").filter(Boolean).map((chunk) => {
    const ev = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
  return { res, events };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minimi-server-"));
  store = await MemoryStore.open(dir);
  setOverride("2026-11-10T12:00:00");
});
afterEach(async () => {
  setOverride(null);
  await awaitExtractions();
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await rm(dir, { recursive: true, force: true });
});

it("GET /api/meta reports provider and today", async () => {
  await start([]);
  const meta = await (await fetch(`${base}/api/meta`)).json();
  expect(meta).toMatchObject({ today: "2026-11-10", provider: "fake", model: "fake-model" });
});

it("a turn streams text and done, and persists user + assistant messages", async () => {
  await start([
    { toolCalls: [{ name: "web_search", input: { query: "neon pricing" } }] },
    { text: "Neon Launch is $24/mo [1]." },
    { json: { title: "Neon pricing", topics: ["neon"], claims: [{ subject: "Neon Launch", predicate: "price", value: "$24/mo", source: 1 }] } },
  ]);
  const session = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
  const { events } = await sse(`/api/sessions/${session.id}/turn`, { text: "What does Neon cost?" });
  const names = events.map((e) => e.event);
  expect(names[0]).toBe("recall");
  expect(names).toContain("status");
  expect(names.at(-1)).toBe("done");
  const text = events.filter((e) => e.event === "text").map((e) => e.data.delta).join("");
  expect(text).toBe("Neon Launch is $24/mo [1].");
  const sources = events.find((e) => e.event === "sources")!.data.sources;
  expect(sources).toEqual([{ id: 1, title: "Neon pricing", url: "https://neon.tech/pricing", publishedDate: "2026-11-07" }]);

  const msgs = await (await fetch(`${base}/api/sessions/${session.id}/messages`)).json();
  expect(msgs.map((m: any) => m.msg.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
  expect(msgs.every((m: any) => m.msg.raw === undefined)).toBe(true);
  expect(msgs.at(-1).meta).toMatchObject({ text: "Neon Launch is $24/mo [1].", sources });

  await awaitExtractions();
  expect(store.getSession(session.id)?.title).toBe("Neon pricing");
  expect(store.claims()[0]).toMatchObject({ subject: "Neon Launch", observedAt: "2026-11-10" });
  const listed = await (await fetch(`${base}/api/sessions`)).json();
  expect(listed[0]).toMatchObject({ id: session.id, title: "Neon pricing" });
});

it("a turn with a date and no record sends a recall event containing 'No record for'", async () => {
  await start([{ text: "I have no record of that day." }, { json: { title: "x", topics: [], claims: [] } }]);
  const session = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
  const { events } = await sse(`/api/sessions/${session.id}/turn`, { text: "What did I ask you on 3 November?" });
  const recall = events.find((e) => e.event === "recall")!.data;
  expect(recall.block).toContain("No record for 2026-11-03");
  expect(recall.summary).toBe("no record for 3 Nov");
});

it("only cited sources are sent", async () => {
  await start([
    { toolCalls: [{ name: "web_search", input: { query: "a" } }] },
    { text: "Nothing useful found." },
    { json: { title: "", topics: [], claims: [] } },
  ]);
  const session = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
  const { events } = await sse(`/api/sessions/${session.id}/turn`, { text: "anything new on neon?" });
  expect(events.find((e) => e.event === "sources")!.data.sources).toEqual([]);
});

it("a provider failure becomes an SSE error event", async () => {
  await start([{ error: new Error("upstream 503") }]);
  const session = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
  const { events } = await sse(`/api/sessions/${session.id}/turn`, { text: "hello" });
  expect(events.at(-1)).toMatchObject({ event: "error", data: { message: expect.stringContaining("upstream 503") } });
});

it("rejects an empty message and an unknown session", async () => {
  await start([]);
  const session = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
  expect((await fetch(`${base}/api/sessions/${session.id}/turn`, { method: "POST", body: JSON.stringify({ text: "  " }) })).status).toBe(400);
  expect((await fetch(`${base}/api/sessions/nope/turn`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).status).toBe(404);
  expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
});

it("POST /api/clock changes today in /api/meta", async () => {
  await start([]);
  await fetch(`${base}/api/clock`, { method: "POST", body: JSON.stringify({ now: "2026-11-03T09:00:00" }) });
  expect((await (await fetch(`${base}/api/meta`)).json()).today).toBe("2026-11-03");
});

it("serves the UI shell", async () => {
  await start([]);
  const res = await fetch(`${base}/`);
  expect(res.headers.get("content-type")).toContain("text/html");
});

it("selectProvider prefers MODEL_PROVIDER, then Anthropic, then Gemini, and names .env.example otherwise", () => {
  expect(selectProvider({ GEMINI_API_KEY: "g" }).name).toBe("gemini");
  expect(selectProvider({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }).name).toBe("anthropic");
  expect(selectProvider({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", MODEL_PROVIDER: "gemini" }).name).toBe("gemini");
  expect(selectProvider({ ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "claude-sonnet-5-5" }).modelLabel).toBe("claude-sonnet-5-5");
  expect(() => selectProvider({})).toThrow(/\.env\.example/);
  expect(() => selectProvider({ MODEL_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
});
