import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dayKey, now, setOverride } from "../src/clock.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { resolveDates } from "../src/memory/recall.ts";
import type { SearchProvider } from "../src/tools/types.ts";
import { SEED_SESSIONS, seed } from "../scripts/seed.ts";
import { runEval, type Question } from "../eval/run.ts";
import questions from "../eval/questions.json" with { type: "json" };
import { fakeProvider, type Scripted } from "./helpers/fakeProvider.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "minimi-seed-")); setOverride("2026-11-10T12:00:00"); });
afterEach(async () => { setOverride(null); await rm(dir, { recursive: true, force: true }); });

const search: SearchProvider = {
  async search() { return [{ title: "Vendor pricing", url: "https://vendor.example/pricing", publishedDate: "2026-11-01", highlights: ["$25/mo"] }]; },
  async contents() { return null; },
};
const turnScript = (claim: string): Scripted[] => [
  { toolCalls: [{ name: "web_search", input: { query: "pricing" } }] },
  { text: `It costs $25/mo [1].` },
  { json: { title: claim, topics: [claim.toLowerCase()], claims: [{ subject: claim, predicate: "price", value: "$25/mo", source: 1 }] } },
];

it("seeds three dated sessions on the days the brief's phrases resolve to, through the real turn path", async () => {
  const store = await MemoryStore.open(dir);
  const provider = fakeProvider(SEED_SESSIONS.flatMap((s) => s.turns.flatMap(() => turnScript(s.title))));
  await seed({ provider, search, store }, { log: () => {} });

  const sessions = store.listSessions();
  expect(sessions).toHaveLength(3);
  expect(sessions.every((s) => s.seeded)).toBe(true);
  const ref = new Date("2026-11-10T12:00:00");
  const days = sessions.map((s) => dayKey(s.startedAt)).sort();
  expect(days).toContain(resolveDates("On Monday", ref)[0].day);
  expect(days).toContain(resolveDates("Last Tuesday", ref)[0].day);
  expect(days).toContain("2026-11-03");
  expect(store.claims().length).toBe(3);
  expect(store.claims().every((c) => c.observedAt !== "2026-11-10")).toBe(true);
  expect(now().toISOString()).toBe(new Date("2026-11-10T12:00:00").toISOString()); // the seed restores the caller's clock
});

it("refuses to seed twice without force", async () => {
  const store = await MemoryStore.open(dir);
  await store.createSession({ startedAt: "2026-11-01T10:00:00Z", seeded: true });
  await expect(seed({ provider: fakeProvider([]), search, store }, { log: () => {} })).rejects.toThrow(/--force/);
});

it("eval question set has 20 entries including the brief's three and five no-search questions", () => {
  const qs = questions as Question[];
  expect(qs).toHaveLength(20);
  expect(new Set(qs.map((q) => q.id)).size).toBe(20);
  expect(qs.filter((q) => !q.needsSearch).length).toBeGreaterThanOrEqual(5);
  expect(qs.some((q) => q.text.includes("3 November"))).toBe(true);
  expect(qs.some((q) => q.text.includes("Postgres"))).toBe(true);
  expect(qs.some((q) => q.text.includes("CRM"))).toBe(true);
});

it("runEval records timing, rounds, searches and the judge verdict per question", async () => {
  const store = await MemoryStore.open(dir);
  const provider = fakeProvider([
    { toolCalls: [{ name: "web_search", input: { query: "neon" } }] },
    { text: "Neon Launch is $25/mo [1]." },
    { json: { title: "t", topics: [], claims: [] } },
    { json: { correct: true, cited: true, notes: "fine" } },
  ]);
  const rows = await runEval({ provider, search, store }, [{ id: "q1", text: "What does Neon cost?", needsSearch: true, expects: ["a price with a citation"] }]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: "q1", rounds: 2, searches: 1, diff: false, correct: true, cited: true, searchedAsExpected: true });
  expect(rows[0].totalMs).toBeGreaterThanOrEqual(0);
  expect(rows[0].firstTokenMs).not.toBeNull();
});

it("runEval grades with a separate judge provider when one is given", async () => {
  const store = await MemoryStore.open(dir);
  const provider = fakeProvider([{ text: "408." }, { json: { title: "t", topics: [], claims: [] } }]);
  const judge = fakeProvider([{ json: { correct: true, cited: true, notes: "ok" } }]);
  const rows = await runEval({ provider, search, store, judge }, [{ id: "math", text: "What is 17% of 2,400?", needsSearch: false, expects: ["408"] }]);
  expect(rows[0]).toMatchObject({ correct: true, searchedAsExpected: true });
  expect(judge.jsonCalls).toHaveLength(1);
  expect(provider.jsonCalls).toHaveLength(1); // only the memory extraction
});

it("a judge failure keeps the answer and timings and leaves only the grade empty", async () => {
  const store = await MemoryStore.open(dir);
  const provider = fakeProvider([{ text: "408." }, { json: { title: "t", topics: [], claims: [] } }]);
  const judge = fakeProvider([{ error: new Error("judge overloaded") }]);
  const rows = await runEval({ provider, search, store, judge }, [{ id: "math", text: "What is 17% of 2,400?", needsSearch: false, expects: ["408"] }]);
  expect(rows[0]).toMatchObject({ answer: "408.", correct: null, cited: null, judgeError: "judge overloaded", searchedAsExpected: true });
  expect(rows[0].error).toBeUndefined();
  expect(rows[0].rounds).toBe(1);
});

it("tells the judge the assistant has memory, so recalled sessions are not marked as invented", async () => {
  const store = await MemoryStore.open(dir);
  const provider = fakeProvider([{ text: "On 3 Nov you asked about laptops." }, { json: { title: "t", topics: [], claims: [] } }]);
  const judge = fakeProvider([{ json: { correct: true, cited: true, notes: "ok" } }]);
  await runEval({ provider, search, store, judge }, [{ id: "mem", text: "What did I ask on 3 November?", needsSearch: false, expects: ["recalls it"] }]);
  expect(judge.jsonCalls[0].system).toMatch(/memory of earlier conversations/i);
  expect(judge.jsonCalls[0].system).toMatch(/not.*(penali[sz]e|count against)/i);
});
