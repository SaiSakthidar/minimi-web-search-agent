import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { formatRecall, recall, resolveDates, tokenize } from "../../src/memory/recall.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import type { ClaimInput } from "../../src/memory/types.ts";

const now = new Date("2026-11-10T12:00:00");
const local = (d: string, h = 10) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).toISOString();
const user = (text: string) => ({ role: "user" as const, parts: [{ type: "text" as const, text }] });
const asst = (text: string) => ({ role: "assistant" as const, parts: [{ type: "text" as const, text }] });

let dir: string;
let store: MemoryStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "minimi-recall-")); store = await MemoryStore.open(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function session(day: string, title: string, topics: string[], turns: [string, string][], seeded = true) {
  const s = await store.createSession({ startedAt: local(day), seeded });
  await store.updateSession(s.id, { title, topics });
  let h = 10;
  for (const [u, a] of turns) {
    await store.appendMessage(s.id, user(u), local(day, h));
    await store.appendMessage(s.id, asst(a), local(day, h));
    h++;
  }
  return s;
}

const claim = (over: Partial<ClaimInput>): ClaimInput => ({
  sessionId: "s", turnId: "t", subject: "x", predicate: "price", value: "$1",
  observedAt: "2026-11-03", sourceUrl: "https://example.com", sourceDate: null, ...over,
});

it("resolves 'last Tuesday' relative to now", () => {
  const r = resolveDates("Last Tuesday I asked about Postgres", now);
  expect(r).toEqual([{ phrase: "Last Tuesday", day: "2026-11-03" }]);
});

it("resolves '3 November' to the past occurrence", () => {
  expect(resolveDates("What did I ask you on 3 November?", now)[0].day).toBe("2026-11-03");
});

it("ignores messages without dates and bare times", () => {
  expect(resolveDates("what is new in CRMs", now)).toEqual([]);
  expect(resolveDates("remind me at 5pm", now)).toEqual([]);
});

it("tokenize lowercases, drops short words and stopwords", () => {
  expect(tokenize("What did I ask about Postgres hosting?")).toEqual(["ask", "postgres", "hosting"]);
});

it("reports a missing day instead of inventing a session", () => {
  const r = recall(store, "What did I ask you on 3 November?", now, { sessionId: "current" });
  expect(r.sessions).toEqual([]);
  expect(r.missingDays).toEqual(["2026-11-03"]);
  expect(formatRecall(r, now)).toContain("No record for 2026-11-03");
});

it("matches a session by date using message timestamps", async () => {
  const s = await session("2026-11-03", "Managed Postgres hosting", ["neon", "supabase"], [["Which Postgres host?", "Neon Launch is $19/mo [1]"]]);
  const r = recall(store, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed?", now, { sessionId: "current" });
  expect(r.sessions).toHaveLength(1);
  expect(r.sessions[0]).toMatchObject({ day: "2026-11-03", matchedBy: "date" });
  expect(r.sessions[0].meta.id).toBe(s.id);
  const block = formatRecall(r, now);
  expect(block).toContain("Today: 2026-11-10");
  expect(block).toContain("Which Postgres host?");
  expect(block).toContain("Neon Launch is $19/mo");
});

it("matches a session by topic when no date is given", async () => {
  await session("2026-11-09", "CRM shortlist", ["hubspot", "pipedrive"], [["Shortlist CRMs for 20 seats", "HubSpot, Pipedrive..."]]);
  await session("2026-11-03", "Travel laptop", ["laptop"], [["best travel laptop", "MacBook Air"]]);
  const r = recall(store, "Has HubSpot changed its pricing?", now, { sessionId: "current" });
  expect(r.sessions.map((s) => s.meta.title)).toEqual(["CRM shortlist"]);
  expect(r.sessions[0].matchedBy).toBe("topic");
});

it("excludes the current session", async () => {
  const s = await session("2026-11-10", "CRM shortlist", ["hubspot"], [["hubspot pricing", "..."]]);
  const r = recall(store, "hubspot pricing today", now, { sessionId: s.id });
  expect(r.sessions).toEqual([]);
});

it("includes claims observed on a matched day and marks closed ones", async () => {
  await session("2026-11-03", "Postgres", [], [["q", "a"]]);
  await store.addClaim(claim({ subject: "Neon Launch", value: "$19/mo", observedAt: "2026-11-03" }));
  await store.addClaim(claim({ subject: "Neon Launch", value: "$24/mo", observedAt: "2026-11-10" }));
  const r = recall(store, "What did I ask on 3 November?", now, { sessionId: "current" });
  expect(r.claims.map((c) => c.value)).toEqual(["$19/mo"]);
  expect(formatRecall(r, now)).toContain("(closed 2026-11-10)");
});

it("caps sessions at 3 and claims at 20", async () => {
  for (let i = 0; i < 5; i++) await session(`2026-11-0${i + 1}`, `hubspot notes ${i}`, ["hubspot"], [["hubspot", "a"]]);
  for (let i = 0; i < 25; i++) await store.addClaim(claim({ subject: `HubSpot plan ${i}`, value: `$${i}` }));
  const r = recall(store, "hubspot pricing", now, { sessionId: "current" });
  expect(r.sessions).toHaveLength(3);
  expect(r.sessions[0].meta.title).toBe("hubspot notes 4");
  expect(r.claims).toHaveLength(20);
});

it("says so explicitly when nothing matches", () => {
  const block = formatRecall(recall(store, "hello there", now, { sessionId: "current" }), now);
  expect(block).toContain("No earlier conversations or claims match");
});

it("trims long assistant answers", async () => {
  await session("2026-11-03", "Long", [], [["q", "x".repeat(5000)]]);
  const block = formatRecall(recall(store, "on 3 November", now, { sessionId: "current" }), now);
  expect(block).not.toContain("x".repeat(2500));
  expect(block).toContain("x".repeat(2400));
});

it("never reports today or future days as missing, and ignores month-only phrases", () => {
  const r = recall(store, "What did I ask you on 3 November? Is your answer still correct today?", now, { sessionId: "current" });
  expect(r.missingDays).toEqual(["2026-11-03"]);
  expect(resolveDates("anything new in November?", now)).toEqual([]);
  expect(recall(store, "remind me next week", now, { sessionId: "current" }).missingDays).toEqual([]);
});

it("points at the current conversation when the asked-about day is in it", async () => {
  const s = await session("2026-11-09", "CRM shortlist", ["crm"], [["Shortlist CRMs", "HubSpot [1]"]]);
  const r = recall(store, "What did I ask you on Monday?", now, { sessionId: s.id });
  expect(r.missingDays).toEqual([]);
  expect(formatRecall(r, now)).toContain("This conversation already has messages from 2026-11-09");
});

it("does not match sessions or claims on generic words alone", async () => {
  await session("2026-11-10", "CRM Pricing Update Check", ["crm", "hubspot"], [["Have CRM prices changed?", "No [1]."]]);
  await session("2026-11-10", "Managed Postgres Entry Plans", ["postgres"], [["Compare the entry paid plans and monthly prices of Supabase and Neon", "Supabase $25 [2]."]]);
  await store.addClaim(claim({ subject: "Apple MacBook Air", predicate: "base model price", value: "$1,299" }));
  const node = recall(store, "What is the latest LTS version of Node.js? Check that the version matches nodejs.org.", now, { sessionId: "current" });
  expect(node.sessions).toEqual([]);
  const vercel = recall(store, "Compare the monthly price of Vercel Pro and Netlify Pro.", now, { sessionId: "current" });
  expect(vercel.sessions).toEqual([]);
  expect(vercel.claims).toEqual([]);
});

it("recalls the clean final answer without diff blocks, old citation numbers or intermediate rounds", async () => {
  const s = await store.createSession({ startedAt: local("2026-11-03"), seeded: true });
  await store.appendMessage(s.id, user("Has Neon changed?"), local("2026-11-03"));
  await store.appendMessage(s.id, asst("Let me check."), local("2026-11-03"));
  const raw = 'Neon is $24 now [2, 3].\n\n```json-diff\n{"items":[]}\n```';
  await store.appendMessage(s.id, asst(raw), local("2026-11-03"), { text: "Neon is $24 now [2, 3].", sources: [], diff: null, recall: null });
  const block = formatRecall(recall(store, "What did I ask on 3 November?", now, { sessionId: "current" }), now);
  expect(block).toContain("assistant: Neon is $24 now.");
  expect(block).not.toContain("json-diff");
  expect(block).not.toContain("[2, 3]");
  expect(block).not.toContain("Let me check.");
});
