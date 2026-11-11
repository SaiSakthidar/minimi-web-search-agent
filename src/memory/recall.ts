// Harness-side recall. Runs before every turn: resolves dates in the user's
// message, finds earlier sessions by date (message timestamps) or by topic,
// picks relevant claims, and renders one block the model reads as a system note.

import * as chrono from "chrono-node";
import { dayKey } from "../clock.ts";
import { tokenize } from "../text.ts";
import type { Claim, SessionMeta, StoredMessage } from "./types.ts";
import type { MemoryStore } from "./store.ts";

export { tokenize };

export const MAX_SESSIONS = 3;
export const MAX_CLAIMS = 20;
export const ASSISTANT_TRIM = 2400;
const MAX_LINES_PER_SESSION = 12;

export type ResolvedDate = { phrase: string; day: string };

/**
 * Words too common in questions to say what a conversation was about. Ignored for topic matching only;
 * fetch ranking still uses them ("price" matters on a pricing page).
 */
const GENERIC = new Set(("ask asked tell told check checked update updated change changed changes compare comparison " +
  "price prices pricing priced cost costs monthly month year plan plans current currently latest today still since " +
  "version new best good cheap cheaper free per question answer correct right now earlier before").split(" "));

const topicWords = (s: string) => tokenize(s).filter((t) => !GENERIC.has(t));
export type RecalledSession = { meta: SessionMeta; day: string; lines: string[]; matchedBy: "date" | "topic" };
export type RecallResult = { dates: ResolvedDate[]; sessions: RecalledSession[]; claims: Claim[]; missingDays: string[]; inThisSession: string[] };

export function resolveDates(text: string, now: Date): ResolvedDate[] {
  const out: ResolvedDate[] = [];
  for (const r of chrono.parse(text, now, { forwardDate: false })) {
    const s = r.start;
    if (!(s.isCertain("day") || s.isCertain("weekday"))) continue; // a bare time or a month on its own is not a day
    const day = dayKey(s.date());
    if (!out.some((d) => d.day === day)) out.push({ phrase: r.text, day });
  }
  return out;
}

function textOf(m: StoredMessage): string {
  if (m.msg.role === "system") return "";
  return m.msg.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
}

/** An old answer as the model should see it now: no diff block, no citation numbers from that turn. */
function cleanAnswer(text: string): string {
  const fence = text.indexOf("```json-diff");
  return (fence >= 0 ? text.slice(0, fence) : text).replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").trim();
}

function renderLines(messages: StoredMessage[]): string[] {
  // Each turn's final answer carries its clean prose in meta; intermediate rounds ("Let me check.") are skipped.
  const hasMeta = messages.some((m) => m.meta);
  const lines: string[] = [];
  for (const m of messages) {
    if (m.msg.role === "system") continue;
    if (m.msg.role === "user") { const t = textOf(m); if (t) lines.push(`user: ${t}`); continue; }
    if (hasMeta && !m.meta) continue;
    const t = cleanAnswer(m.meta?.text ?? textOf(m));
    if (t) lines.push(`assistant: ${t.length > ASSISTANT_TRIM ? t.slice(0, ASSISTANT_TRIM) + " …[trimmed]" : t}`);
  }
  return lines.slice(-MAX_LINES_PER_SESSION);
}

function overlap(a: Set<string>, text: string): number {
  let n = 0;
  for (const t of new Set(topicWords(text))) if (a.has(t)) n++;
  return n;
}

export function recall(store: MemoryStore, text: string, now: Date, exclude: { sessionId: string }): RecallResult {
  const dates = resolveDates(text, now);
  const words = new Set(topicWords(text));
  const sessions: RecalledSession[] = [];
  const missingDays: string[] = [];
  const inThisSession: string[] = [];
  const today = dayKey(now);

  // 1. Date matches, by message timestamp, grouped per session. Today and later are not memory questions.
  for (const { day } of dates) {
    if (day >= today) continue;
    const all = store.messagesOnDay(day);
    const msgs = all.filter((m) => m.sessionId !== exclude.sessionId);
    if (msgs.length === 0) {
      if (all.length) inThisSession.push(day);
      else missingDays.push(day);
      continue;
    }
    const bySession = new Map<string, StoredMessage[]>();
    for (const m of msgs) bySession.set(m.sessionId, [...(bySession.get(m.sessionId) ?? []), m]);
    for (const [id, ms] of bySession) {
      const meta = store.getSession(id);
      if (meta) sessions.push({ meta, day, lines: renderLines(ms), matchedBy: "date" });
    }
  }

  // 2. Topic matches fill the remaining slots.
  const taken = new Set(sessions.map((s) => s.meta.id));
  const scored = store.listSessions() // newest first, so a stable sort breaks ties by recency
    .filter((m) => m.id !== exclude.sessionId && !taken.has(m.id))
    .map((meta) => {
      const all = store.getMessages(meta.id);
      const firstUser = all.find((m) => m.msg.role === "user" && textOf(m));
      const score = overlap(words, [meta.title, ...meta.topics, firstUser ? textOf(firstUser) : ""].join(" "));
      return { meta, all, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const x of scored) {
    if (sessions.length >= MAX_SESSIONS) break;
    sessions.push({ meta: x.meta, day: dayKey(x.meta.startedAt), lines: renderLines(x.all), matchedBy: "topic" });
  }

  // 3. Claims: everything observed on a matched day, then the best topic overlaps.
  const matchedDays = new Set(dates.map((d) => d.day).filter((d) => d < today));
  const all = store.claims();
  const onDay = all.filter((c) => matchedDays.has(c.observedAt.slice(0, 10)));
  const byTopic = all
    .filter((c) => !onDay.includes(c))
    .map((c) => ({ c, score: overlap(words, `${c.subject} ${c.predicate}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.c.observedAt.localeCompare(a.c.observedAt))
    .map((x) => x.c);

  return { dates, sessions: sessions.slice(0, MAX_SESSIONS), claims: [...onDay, ...byTopic].slice(0, MAX_CLAIMS), missingDays, inThisSession };
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatRecall(r: RecallResult, now: Date): string {
  const out = ["[Memory recall, assembled by the harness before this turn. The user does not see this block.]"];
  out.push(`Today: ${dayKey(now)} (${WEEKDAY[now.getDay()]})`);
  if (r.dates.length) out.push(`Resolved dates: ${r.dates.map((d) => `"${d.phrase}" = ${d.day}`).join("; ")}`);
  for (const d of r.missingDays) out.push(`No record for ${d} in earlier conversations.`);
  for (const d of r.inThisSession) out.push(`This conversation already has messages from ${d}; they are in the transcript above.`);

  if (r.sessions.length === 0 && r.claims.length === 0) {
    out.push("No earlier conversations or claims match this message.");
    return out.join("\n");
  }
  for (const s of r.sessions) {
    const tags = [s.meta.seeded ? "seeded" : null, `matched by ${s.matchedBy}`].filter(Boolean).join(", ");
    out.push("", `Session ${s.day} "${s.meta.title || "untitled"}" (${tags})`, ...s.lines.map((l) => `  ${l}`));
  }
  if (r.claims.length) {
    out.push("", "Claims stated earlier (current unless marked closed):");
    for (const c of r.claims) {
      const src = `${c.sourceUrl}, ${c.sourceDate ?? "undated"}`;
      const closed = c.validTo ? ` (closed ${c.validTo})` : "";
      out.push(`  [observed ${c.observedAt}] ${c.subject} · ${c.predicate} = ${c.value} (${src})${closed}`);
    }
  }
  return out.join("\n");
}
