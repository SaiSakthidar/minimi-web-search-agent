// Harness-side recall. Runs before every turn: resolves dates in the user's
// message, finds earlier sessions by date (message timestamps) or by topic
// (keyword overlap fused with local-embedding similarity), picks relevant
// claims, and renders one block the model reads as a system note.

import * as chrono from "chrono-node";
import { dayKey } from "../clock.ts";
import { tokenize } from "../text.ts";
import { cosine, type Embedder } from "./embed.ts";
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
  "version new best good cheap cheaper free per question answer correct right now earlier before " +
  // plan-tier names every vendor uses
  "pro plus premium basic starter standard team teams business enterprise hobby launch scale growth essentials professional").split(" "));

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

/** Reciprocal rank fusion (k = 60): items ranked well by several lists come first; ties keep first-seen order. */
export function fuseRankings(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Semantic gate, calibrated on bge-small-en-v1.5 with real session labels: a label counts only when its
 * cosine is above SEMANTIC_FLOOR and leads the median of the other labels by SEMANTIC_LEAD. Relevant
 * matches led by >= 0.14; unrelated questions (other vendors, arithmetic, greetings) by <= 0.09.
 */
export const SEMANTIC_FLOOR = 0.58;
export const SEMANTIC_LEAD = 0.11;
const EMBED_TIMEOUT_MS = 1500;

async function semanticMatches(embedder: Embedder, query: string, labels: string[], timeoutMs: number): Promise<Map<string, number>> {
  // A bare name ("netlify") embeds as a generic topic and scores high against any question in its field;
  // names are matched exactly by the keyword ranking instead.
  const uniq = [...new Set(labels.filter((l) => l.trim().split(/\s+/).length >= 2))];
  if (!uniq.length) return new Map();
  let timer: NodeJS.Timeout | undefined;
  try {
    const [[q], docs] = await Promise.race([
      Promise.all([embedder.embed([query], "query"), embedder.embed(uniq, "document")]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("embedding timed out")), timeoutMs); }),
    ]);
    const scores = uniq.map((_, i) => cosine(q, docs[i]));
    const out = new Map<string, number>();
    scores.forEach((sc, i) => {
      const others = scores.filter((_, j) => j !== i).sort((a, b) => a - b);
      const lead = others.length ? sc - others[Math.floor(others.length / 2)] : Infinity;
      if (sc >= SEMANTIC_FLOOR && lead >= SEMANTIC_LEAD) out.set(uniq[i], sc);
    });
    return out;
  } catch {
    return new Map(); // model missing, still loading, or failed: keyword recall alone
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a session is about, as short labels for embedding: the title and each topic separately, with generic
 * words removed ("CRM Pricing Comparison for Sales Team" -> "crm sales"), so one noisy topic or a phrase
 * like "pricing comparison" cannot dominate the match. A session scores as its best label.
 */
export function sessionLabels(m: SessionMeta): string[] {
  const clean = (s: string) => topicWords(s).join(" ");
  return [...new Set([clean(m.title), ...m.topics.map(clean)].filter(Boolean))];
}

const claimLabel = (c: Claim) => topicWords(c.subject).join(" ") || c.subject;

export async function recall(
  store: MemoryStore, text: string, now: Date, exclude: { sessionId: string },
  embedder?: Embedder, opts: { timeoutMs?: number } = {},
): Promise<RecallResult> {
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

  // 2. Topic candidates, two rankings fused: keyword overlap (names, products) and meaning (paraphrase).
  const taken = new Set(sessions.map((s) => s.meta.id));
  const candidates = store.listSessions().filter((m) => m.id !== exclude.sessionId && !taken.has(m.id));
  const allClaims = store.claims();
  const semantic = embedder
    ? await semanticMatches(embedder, text, [...candidates.flatMap(sessionLabels), ...allClaims.map(claimLabel)], opts.timeoutMs ?? EMBED_TIMEOUT_MS)
    : new Map<string, number>();
  const sessionScore = (m: SessionMeta) => Math.max(-Infinity, ...sessionLabels(m).map((l) => semantic.get(l) ?? -Infinity));

  const keywordSessions = candidates // newest first, so a stable sort breaks ties by recency
    .map((meta) => {
      // Title and topics say what a session is about; its first question only stands in until it has a title.
      const firstUser = meta.title ? undefined : store.getMessages(meta.id).find((m) => m.msg.role === "user" && textOf(m));
      return { id: meta.id, score: overlap(words, [meta.title, ...meta.topics, firstUser ? textOf(firstUser) : ""].join(" ")) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);
  const semanticSessions = candidates
    .filter((m) => sessionScore(m) > -Infinity)
    .sort((a, b) => sessionScore(b) - sessionScore(a))
    .map((m) => m.id);
  for (const id of fuseRankings([keywordSessions, semanticSessions])) {
    if (sessions.length >= MAX_SESSIONS) break;
    const meta = store.getSession(id)!;
    sessions.push({ meta, day: dayKey(meta.startedAt), lines: renderLines(store.getMessages(id)), matchedBy: "topic" });
  }

  // 3. Claims: everything observed on a matched day, then keyword and semantic matches on the subject, fused.
  const matchedDays = new Set(dates.map((d) => d.day).filter((d) => d < today));
  const onDay = allClaims.filter((c) => matchedDays.has(c.observedAt.slice(0, 10)));
  const rest = allClaims.filter((c) => !onDay.includes(c));
  const keywordClaims = rest
    .map((c) => ({ c, score: overlap(words, c.subject) })) // the subject says what a fact is about; its attribute ("billed annually") does not
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.c.observedAt.localeCompare(a.c.observedAt))
    .map((x) => x.c.id);
  const semanticClaims = rest
    .filter((c) => semantic.has(claimLabel(c)))
    .sort((a, b) => semantic.get(claimLabel(b))! - semantic.get(claimLabel(a))! || b.observedAt.localeCompare(a.observedAt))
    .map((c) => c.id);
  // A recalled conversation brings its own facts: those are what an "anything changed?" question re-checks.
  const recalledIds = new Set(sessions.slice(0, MAX_SESSIONS).map((x) => x.meta.id));
  const fromSessions = rest.filter((c) => recalledIds.has(c.sessionId)).map((c) => c.id);
  const byId = new Map(rest.map((c) => [c.id, c]));
  const byTopic = [...new Set([...fromSessions, ...fuseRankings([keywordClaims, semanticClaims])])].map((id) => byId.get(id)!);

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
