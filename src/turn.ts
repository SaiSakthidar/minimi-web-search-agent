// One user turn, end to end. Used by the HTTP server, the seed script and the
// eval so all three exercise exactly the same path:
// clock -> recall -> append (recall note + user) -> loop -> persist -> extract.

import { randomUUID } from "node:crypto";
import { runTurn, type TurnEvent, type TurnResult } from "./agent/loop.ts";
import { pickEffort, systemPrompt } from "./agent/prompt.ts";
import { now } from "./clock.ts";
import type { LlmProvider, Msg } from "./llm/types.ts";
import { scheduleExtraction } from "./memory/extract.ts";
import { formatRecall, recall, type RecallResult } from "./memory/recall.ts";
import type { MemoryStore } from "./memory/store.ts";
import type { SourceRef, ToolHandler } from "./tools/types.ts";

export type TurnDeps = { provider: LlmProvider; store: MemoryStore; tools: ToolHandler[]; log?: (e: unknown) => void };

export type HandleEvent =
  | TurnEvent
  | { type: "recall"; block: string; summary: string | null }
  | { type: "sources"; sources: SourceRef[] };

const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function recallSummary(r: RecallResult): string | null {
  const bits: string[] = [];
  if (r.sessions.length === 1) bits.push(`recalled ${shortDay(r.sessions[0].day)} session`);
  else if (r.sessions.length > 1) bits.push(`recalled ${r.sessions.length} sessions (${r.sessions.map((s) => shortDay(s.day)).join(", ")})`);
  if (r.claims.length) bits.push(`${r.claims.length} earlier claim${r.claims.length > 1 ? "s" : ""}`);
  for (const d of r.missingDays) bits.push(`no record for ${shortDay(d)}`);
  return bits.length ? bits.join(" · ") : null;
}

/** Sources the answer actually cites, by [n] in the prose or a diff row. */
export function citedSources(result: Pick<TurnResult, "text" | "diff" | "sources">): SourceRef[] {
  const ids = new Set([...result.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  for (const d of result.diff ?? []) if (d.source !== null) ids.add(d.source);
  return result.sources.filter((s) => ids.has(s.id));
}

export async function handleTurn(deps: TurnDeps, sessionId: string, text: string, onEvent: (e: HandleEvent) => void, signal?: AbortSignal): Promise<TurnResult & { cited: SourceRef[] }> {
  const { store, provider } = deps;
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  const isFirstTurn = !session.title; // set by extraction after the first answered turn

  const at = now();
  const r = recall(store, text, at, { sessionId });
  const block = formatRecall(r, at);
  const summary = recallSummary(r);
  onEvent({ type: "recall", block, summary });

  // The recall note goes after the user message: a mid-conversation system message must follow a user turn.
  const userMsg: Msg = { role: "user", parts: [{ type: "text", text }] };
  await store.appendMessage(sessionId, userMsg, at.toISOString());
  await store.appendMessage(sessionId, { role: "system", text: block }, at.toISOString());

  let result: TurnResult;
  try {
    result = await runTurn({
      provider,
      system: systemPrompt(),
      history: store.getMessages(sessionId).map((m) => m.msg),
      tools: deps.tools,
      effort: pickEffort(text),
      onEvent,
      signal,
    });
  } catch (e) {
    // Close the turn so the stored transcript stays valid to replay; the next turn starts cleanly.
    const note = signal?.aborted ? "(stopped before answering)" : "(this turn failed before an answer)";
    await store.appendMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: note }] }, now().toISOString(),
      { text: note, sources: [], diff: null, recall: summary });
    throw e;
  }

  const cited = citedSources(result);
  onEvent({ type: "sources", sources: cited });
  for (const [i, m] of result.newMessages.entries()) {
    const isLast = i === result.newMessages.length - 1;
    const meta = isLast ? { text: result.text, sources: cited, diff: result.diff, recall: summary } : undefined;
    await store.appendMessage(sessionId, m, now().toISOString(), meta);
  }

  scheduleExtraction(provider, store, {
    sessionId, turnId: randomUUID(), userText: text, assistantText: result.text,
    sources: cited, observedAt: at.toISOString(), isFirstTurn,
  }, deps.log ?? ((e) => console.warn("[extract]", (e as Error).message ?? e)));
  return { ...result, cited };
}
