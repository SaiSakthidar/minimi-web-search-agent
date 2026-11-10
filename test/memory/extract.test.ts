import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { awaitExtractions, extractTurn, scheduleExtraction, type ExtractInput } from "../../src/memory/extract.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { fakeProvider } from "../helpers/fakeProvider.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "minimi-extract-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const input = (over: Partial<ExtractInput> = {}): ExtractInput => ({
  sessionId: "s1", turnId: "t1",
  userText: "Which Postgres host?", assistantText: "Neon Launch is $19/mo [1]. Supabase Pro is $25/mo.",
  sources: [{ id: 1, title: "Neon pricing", url: "https://neon.tech/pricing", publishedDate: "2026-10-12" }],
  observedAt: new Date(2026, 10, 3, 10).toISOString(), isFirstTurn: true, ...over,
});

const json = {
  title: "Managed Postgres hosting",
  topics: ["postgres", "neon"],
  claims: [
    { subject: "Neon Launch", predicate: "price", value: "$19/mo", source: 1 },
    { subject: "Supabase Pro", predicate: "price", value: "$25/mo", source: 7 },
  ],
};

it("drops claims whose source is not a cited result and stamps kept ones with source and day", async () => {
  const provider = fakeProvider([{ json }]);
  const out = await extractTurn(provider, input());
  expect(out.claims).toEqual([{
    sessionId: "s1", turnId: "t1", subject: "Neon Launch", predicate: "price", value: "$19/mo",
    observedAt: "2026-11-03", sourceUrl: "https://neon.tech/pricing", sourceDate: "2026-10-12",
  }]);
  expect(out.title).toBe("Managed Postgres hosting");
  expect(provider.jsonCalls[0].prompt).toContain("Neon Launch is $19/mo [1]");
  expect(provider.jsonCalls[0].prompt).toContain("[1] Neon pricing");
});

it("only proposes a title on the first turn", async () => {
  const out = await extractTurn(fakeProvider([{ json }]), input({ isFirstTurn: false }));
  expect(out.title).toBeUndefined();
});

it("skips the model call when the answer cited nothing and it is not the first turn", async () => {
  const provider = fakeProvider([]);
  const out = await extractTurn(provider, input({ sources: [], isFirstTurn: false }));
  expect(out).toEqual({ topics: [], claims: [] });
  expect(provider.jsonCalls).toHaveLength(0);
});

it("scheduleExtraction applies title, merges topics, and adds claims", async () => {
  const store = await MemoryStore.open(dir);
  await store.createSession({ id: "s1", startedAt: "2026-11-03T10:00:00Z" });
  await store.updateSession("s1", { topics: ["databases"] });
  scheduleExtraction(fakeProvider([{ json }]), store, input(), () => {});
  await awaitExtractions();
  expect(store.getSession("s1")).toMatchObject({ title: "Managed Postgres hosting", topics: ["databases", "postgres", "neon"] });
  expect(store.claims()).toHaveLength(1);
});

it("a provider error does not reject scheduleExtraction and is logged", async () => {
  const store = await MemoryStore.open(dir);
  await store.createSession({ id: "s1", startedAt: "2026-11-03T10:00:00Z" });
  const logged: unknown[] = [];
  expect(() => scheduleExtraction(fakeProvider([{ error: new Error("quota") }]), store, input(), (e) => logged.push(e))).not.toThrow();
  await awaitExtractions();
  expect(logged).toHaveLength(1);
  expect(store.claims()).toHaveLength(0);
});
