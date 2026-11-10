// The provider-neutral tool loop. Streams text, runs every tool call of a
// round in parallel, caps rounds, and keeps the turn's history append-only.

import type { Effort, LlmProvider, Msg, TextPart, ToolCallPart, ToolResultPart } from "../llm/types.ts";
import { newTurnContext, type SourceRef, type ToolHandler } from "../tools/types.ts";
import { DIFF_FENCE, lastRoundNote, type DiffItem } from "./prompt.ts";

export const MAX_ROUNDS = 4;

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "status"; text: string }
  | { type: "diff"; items: DiffItem[] }
  | { type: "notice"; text: string };

export type TurnResult = { newMessages: Msg[]; text: string; diff: DiffItem[] | null; sources: SourceRef[]; rounds: number };

const VERDICTS = new Set(["changed", "same", "unverified"]);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : v === null || v === undefined ? null : String(v));

export function splitDiff(text: string): { prose: string; diff: DiffItem[] | null } {
  const start = text.indexOf(DIFF_FENCE);
  if (start < 0) return { prose: text.trim(), diff: null };
  const bodyStart = start + DIFF_FENCE.length;
  const end = text.indexOf("```", bodyStart);
  const body = text.slice(bodyStart, end < 0 ? undefined : end);
  const prose = (text.slice(0, start) + (end < 0 ? "" : text.slice(end + 3))).trim();
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.items)) return { prose, diff: null };
    const diff = parsed.items
      .filter((x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as any).item === "string")
      .map((x: Record<string, unknown>): DiffItem => ({
        item: String(x.item),
        before: str(x.before), beforeDate: str(x.beforeDate),
        after: str(x.after), afterDate: str(x.afterDate),
        verdict: VERDICTS.has(x.verdict as string) ? (x.verdict as DiffItem["verdict"]) : "unverified",
        source: typeof x.source === "number" ? x.source : null,
      }));
    return { prose, diff: diff.length ? diff : null };
  } catch {
    return { prose, diff: null };
  }
}

/** Streams text up to the diff fence, holding back any tail that could be the start of the fence. */
class FenceGate {
  private buf = "";
  private emitted = 0;
  private fenced = false;
  constructor(private emit: (s: string) => void) {}

  push(delta: string): void {
    this.buf += delta;
    if (this.fenced) return;
    const at = this.buf.indexOf(DIFF_FENCE);
    if (at >= 0) { this.out(at); this.fenced = true; return; }
    let hold = 0;
    for (let k = Math.min(DIFF_FENCE.length - 1, this.buf.length); k > 0; k--) {
      if (DIFF_FENCE.startsWith(this.buf.slice(-k))) { hold = k; break; }
    }
    this.out(this.buf.length - hold);
  }

  /** End of round: release held text; after a closed fence, release what follows it. */
  flush(): string {
    if (!this.fenced) this.out(this.buf.length);
    else {
      const close = this.buf.indexOf("```", this.buf.indexOf(DIFF_FENCE) + DIFF_FENCE.length);
      if (close >= 0 && this.buf.slice(close + 3).trim()) { this.emitted = close + 3; this.out(this.buf.length); }
    }
    return this.buf;
  }

  private out(upTo: number): void {
    if (upTo > this.emitted) { this.emit(this.buf.slice(this.emitted, upTo)); this.emitted = upTo; }
  }
}

export async function runTurn(opts: {
  provider: LlmProvider; system: string; history: Msg[]; tools: ToolHandler[];
  effort: Effort; onEvent: (e: TurnEvent) => void; signal?: AbortSignal;
}): Promise<TurnResult> {
  const { provider, onEvent } = opts;
  // Replay guard: provider-native content only goes back to the provider that produced it.
  const messages: Msg[] = opts.history.map((m) =>
    m.role === "assistant" && m.raw && m.raw.provider !== provider.name ? { role: "assistant", parts: m.parts } : m);
  const newMessages: Msg[] = [];
  const append = (m: Msg) => { messages.push(m); newMessages.push(m); };
  const ctx = newTurnContext((text) => onEvent({ type: "status", text }));
  const byName = new Map(opts.tools.map((t) => [t.spec.name, t]));
  let fullText = "";
  let rounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const last = round === MAX_ROUNDS;
    if (last) append({ role: "system", text: lastRoundNote() });
    rounds = round;

    if (fullText && !/\s$/.test(fullText)) onEvent({ type: "text", delta: "\n\n" });
    const gate = new FenceGate((delta) => onEvent({ type: "text", delta }));
    const calls: ToolCallPart[] = [];
    let stop: string = "end";
    let raw: Extract<Msg, { role: "assistant" }>["raw"];
    for await (const ev of provider.stream({ system: opts.system, messages, tools: last ? [] : opts.tools.map((t) => t.spec), effort: opts.effort, signal: opts.signal })) {
      if (ev.type === "text") gate.push(ev.delta);
      else if (ev.type === "tool_call") calls.push({ type: "tool_call", id: ev.id, name: ev.name, input: ev.input });
      else { stop = ev.stop; raw = ev.raw; }
    }
    const text = gate.flush();
    if (text) fullText = fullText && !/\s$/.test(fullText) ? `${fullText}\n\n${text}` : fullText + text;

    const textParts: TextPart[] = text ? [{ type: "text", text }] : [];
    if (last && calls.length) {
      // Tools were withdrawn for this round; unanswered calls (and the raw that holds them) must not enter the transcript.
      append({ role: "assistant", parts: textParts });
    } else {
      append({ role: "assistant", parts: [...textParts, ...calls], ...(raw ? { raw } : {}) });
    }

    if (stop === "max_tokens") { onEvent({ type: "notice", text: "The answer was cut short." }); break; }
    if (stop === "refusal") { onEvent({ type: "notice", text: "The model declined to answer this." }); break; }
    if (stop !== "tool_calls" || last) break;
    if (calls.length === 0) continue; // a paused turn: send the history back and let the model resume

    const results: ToolResultPart[] = await Promise.all(calls.map(async (c): Promise<ToolResultPart> => {
      const handler = byName.get(c.name);
      if (!handler) return { type: "tool_result", callId: c.id, name: c.name, content: `Unknown tool "${c.name}".`, isError: true };
      try {
        const r = await handler.run(c.input, ctx);
        return { type: "tool_result", callId: c.id, name: c.name, content: r.content, ...(r.isError ? { isError: true } : {}) };
      } catch (e) {
        return { type: "tool_result", callId: c.id, name: c.name, content: `Tool failed: ${(e as Error).message}`, isError: true };
      }
    }));
    append({ role: "user", parts: results });
  }

  const { prose, diff } = splitDiff(fullText);
  if (diff) onEvent({ type: "diff", items: diff });
  if (!prose && !diff) onEvent({ type: "notice", text: "No answer was produced. Try asking again." });
  return { newMessages, text: prose, diff, sources: ctx.sources, rounds };
}
