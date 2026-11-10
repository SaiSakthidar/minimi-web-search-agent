import type { JsonRequest, LlmEvent, LlmProvider, StopReason, StreamRequest } from "../../src/llm/types.ts";

export type Scripted = { text?: string; toolCalls?: { name: string; input: unknown }[]; stop?: StopReason; json?: unknown; error?: Error };

/** A provider that replays a script: one entry per stream() or completeJson() call, in order. */
export function fakeProvider(script: Scripted[]): LlmProvider & { calls: StreamRequest[]; jsonCalls: JsonRequest[] } {
  const queue = [...script];
  const calls: StreamRequest[] = [];
  const jsonCalls: JsonRequest[] = [];
  let n = 0;
  const next = () => {
    const s = queue.shift();
    if (!s) throw new Error("fakeProvider: script exhausted");
    return s;
  };
  return {
    name: "fake",
    modelLabel: "fake-model",
    calls,
    jsonCalls,
    async *stream(req: StreamRequest): AsyncIterable<LlmEvent> {
      calls.push(structuredClone({ ...req, signal: undefined }));
      const s = next();
      if (s.error) throw s.error;
      const text = s.text ?? "";
      for (let i = 0; i < text.length; i += 3) yield { type: "text", delta: text.slice(i, i + 3) };
      const tc = s.toolCalls ?? [];
      for (const call of tc) yield { type: "tool_call", id: `call-${++n}`, name: call.name, input: call.input };
      yield { type: "done", stop: s.stop ?? (tc.length ? "tool_calls" : "end"), raw: { provider: "fake", data: { n: calls.length } } };
    },
    async completeJson<T>(req: JsonRequest): Promise<T> {
      jsonCalls.push(req);
      const s = next();
      if (s.error) throw s.error;
      return s.json as T;
    },
  };
}
