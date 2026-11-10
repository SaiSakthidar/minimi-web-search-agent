import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dayKey } from "../../src/clock.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import type { ClaimInput } from "../../src/memory/types.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "minimi-store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const base: ClaimInput = {
  sessionId: "s1", turnId: "t1", subject: "", predicate: "", value: "",
  observedAt: "", sourceUrl: "https://neon.tech/pricing", sourceDate: null,
};

it("round-trips a session and messages through disk", async () => {
  const s = await MemoryStore.open(dir);
  const sess = await s.createSession({ startedAt: "2026-11-03T09:00:00Z" });
  await s.appendMessage(sess.id, { role: "user", parts: [{ type: "text", text: "hi" }] }, "2026-11-03T09:00:01Z");
  const s2 = await MemoryStore.open(dir);
  expect(s2.getMessages(sess.id)).toHaveLength(1);
  expect(s2.getSession(sess.id)?.startedAt).toBe("2026-11-03T09:00:00Z");
  expect(s2.messagesOnDay(dayKey("2026-11-03T09:00:01Z"))[0].msg.role).toBe("user");
});

it("lists sessions newest first", async () => {
  const s = await MemoryStore.open(dir);
  await s.createSession({ id: "old", startedAt: "2026-11-01T09:00:00Z" });
  await s.createSession({ id: "new", startedAt: "2026-11-05T09:00:00Z", seeded: true });
  expect(s.listSessions().map((x) => x.id)).toEqual(["new", "old"]);
  expect(s.getSession("new")?.seeded).toBe(true);
});

it("messagesOnDay spans sessions in chronological order", async () => {
  const s = await MemoryStore.open(dir);
  const a = await s.createSession({ startedAt: "2026-11-03T08:00:00Z" });
  const b = await s.createSession({ startedAt: "2026-11-03T08:00:00Z" });
  await s.appendMessage(b.id, { role: "user", parts: [{ type: "text", text: "second" }] }, "2026-11-03T12:00:00Z");
  await s.appendMessage(a.id, { role: "user", parts: [{ type: "text", text: "first" }] }, "2026-11-03T11:00:00Z");
  const day = s.messagesOnDay(dayKey("2026-11-03T11:00:00Z"));
  expect(day.map((m) => m.sessionId)).toEqual([a.id, b.id]);
});

it("closes a contradicted claim and keeps the old record", async () => {
  const s = await MemoryStore.open(dir);
  await s.addClaim({ ...base, subject: "Neon Launch", predicate: "price", value: "$19/mo", observedAt: "2026-11-03" });
  await s.addClaim({ ...base, subject: "neon launch ", predicate: "Price", value: "$24/mo", observedAt: "2026-11-10" });
  const [old, fresh] = s.claims();
  expect(old.validTo).toBe("2026-11-10");
  expect(fresh.validTo).toBeNull();
  expect(fresh.validFrom).toBe("2026-11-10");
  const reopened = await MemoryStore.open(dir);
  expect(reopened.claims()).toHaveLength(2);
  expect(reopened.claims().find((c) => c.id === old.id)!.validTo).toBe("2026-11-10");
});

it("same value does not close the earlier claim", async () => {
  const s = await MemoryStore.open(dir);
  await s.addClaim({ ...base, subject: "Supabase Pro", predicate: "price", value: "$25/mo", observedAt: "2026-11-03" });
  await s.addClaim({ ...base, subject: "Supabase Pro", predicate: "price", value: "$25/mo", observedAt: "2026-11-10" });
  expect(s.claims().map((c) => c.validTo)).toEqual([null, null]);
});

it("updateSession persists title and topics", async () => {
  const s = await MemoryStore.open(dir);
  const sess = await s.createSession({ startedAt: "2026-11-03T09:00:00Z" });
  await s.appendMessage(sess.id, { role: "user", parts: [{ type: "text", text: "hi" }] }, "2026-11-03T09:00:01Z");
  await s.updateSession(sess.id, { title: "Postgres hosting", topics: ["neon", "supabase"] });
  const s2 = await MemoryStore.open(dir);
  expect(s2.getSession(sess.id)).toMatchObject({ title: "Postgres hosting", topics: ["neon", "supabase"] });
  expect(s2.getMessages(sess.id)).toHaveLength(1);
});

it("a rewrite racing an append never duplicates the message on disk", async () => {
  const s = await MemoryStore.open(dir);
  const sess = await s.createSession({ startedAt: "2026-11-03T09:00:00Z" });
  const pending = [
    s.updateSession(sess.id, { title: "racing" }),
    s.appendMessage(sess.id, { role: "user", parts: [{ type: "text", text: "one" }] }, "2026-11-03T09:00:01Z"),
  ];
  await Promise.all(pending);
  expect((await MemoryStore.open(dir)).getMessages(sess.id)).toHaveLength(1);
});
