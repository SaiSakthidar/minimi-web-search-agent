// After a turn is persisted, a cheap structured-output call pulls the cited
// claims, topics, and (first turn) a session title out of it. Off the response
// path: failures are logged and never reach the user.

import { dayKey } from "../clock.ts";
import type { LlmProvider } from "../llm/types.ts";
import type { SourceRef } from "../tools/types.ts";
import type { MemoryStore } from "./store.ts";
import type { ClaimInput } from "./types.ts";

export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", description: "3 to 6 word title for the conversation; empty string if not asked for" },
    topics: { type: "array", items: { type: "string" }, description: "Up to 6 lowercase keywords: products, vendors, subjects" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string", description: "The specific thing, e.g. 'HubSpot Sales Hub Starter'" },
          predicate: { type: "string", description: "Short attribute, e.g. 'price', 'free tier storage', 'release date'" },
          value: { type: "string", description: "The value as stated, with units, e.g. '$20 per seat per month'" },
          source: { type: "integer", description: "The [n] citation number the answer gave for this fact" },
        },
        required: ["subject", "predicate", "value", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "topics", "claims"],
  additionalProperties: false,
};

export type ExtractInput = {
  sessionId: string; turnId: string; userText: string; assistantText: string;
  sources: SourceRef[]; observedAt: string; isFirstTurn: boolean;
};

type Extracted = { title?: string; topics?: string[]; claims?: { subject?: string; predicate?: string; value?: string; source?: number }[] };

const SYSTEM =
  "You extract structured memory from one turn of a research chat. Record only facts the assistant stated WITH a " +
  "citation marker [n]; ignore uncited statements, opinions, and anything the user said. One claim per fact. Keep " +
  "subjects specific and consistently named. For topics, list only the products, vendors or subjects the user asked " +
  "about in their message, not everything the answer happens to mention. Return JSON matching the schema.";

export async function extractTurn(provider: LlmProvider, input: ExtractInput): Promise<{ title?: string; topics: string[]; claims: ClaimInput[] }> {
  if (input.sources.length === 0 && !input.isFirstTurn) return { topics: [], claims: [] };
  const sourceList = input.sources.map((s) => `[${s.id}] ${s.title} (${s.url}, ${s.publishedDate ?? "undated"})`).join("\n");
  const prompt = [
    `User asked:\n${input.userText}`,
    `Assistant answered:\n${input.assistantText}`,
    `Sources cited this turn:\n${sourceList || "(none)"}`,
    input.isFirstTurn ? "This is the first turn: give the conversation a title." : "Not the first turn: return an empty title.",
  ].join("\n\n");
  const out = await provider.completeJson<Extracted>({ system: SYSTEM, prompt, schema: EXTRACT_SCHEMA });

  const byId = new Map(input.sources.map((s) => [s.id, s]));
  const observedAt = dayKey(input.observedAt);
  const claims: ClaimInput[] = [];
  for (const c of out.claims ?? []) {
    const src = typeof c.source === "number" ? byId.get(c.source) : undefined;
    if (!src || !c.subject?.trim() || !c.predicate?.trim() || !c.value?.trim()) continue;
    claims.push({
      sessionId: input.sessionId, turnId: input.turnId,
      subject: c.subject.trim(), predicate: c.predicate.trim(), value: c.value.trim(),
      observedAt, sourceUrl: src.url, sourceDate: src.publishedDate,
    });
  }
  const title = input.isFirstTurn && out.title?.trim() ? out.title.trim() : undefined;
  const topics = (out.topics ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 6);
  return { ...(title ? { title } : {}), topics, claims };
}

const pending = new Set<Promise<void>>();

/** Fire-and-forget extraction; errors go to `log`. */
export function scheduleExtraction(provider: LlmProvider, store: MemoryStore, input: ExtractInput, log: (e: unknown) => void): void {
  const job = (async () => {
    const { title, topics, claims } = await extractTurn(provider, input);
    const meta = store.getSession(input.sessionId);
    if (meta && (title || topics.length)) {
      await store.updateSession(input.sessionId, {
        ...(title ? { title } : {}),
        topics: [...new Set([...meta.topics, ...topics])].slice(0, 12),
      });
    }
    for (const c of claims) await store.addClaim(c);
  })().catch(log);
  pending.add(job);
  job.finally(() => pending.delete(job));
}

/** Resolves when every scheduled extraction has finished (used by the seed script, eval, and tests). */
export async function awaitExtractions(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
