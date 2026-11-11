import { expect, it } from "vitest";
import { StepAccumulator, toGeminiSteps, toGeminiTools } from "../../src/llm/gemini.ts";

it("wraps a system Msg as a delimited user_input note", () => {
  expect(toGeminiSteps([{ role: "system", text: "recall block" }])).toEqual([
    { type: "user_input", content: [{ type: "text", text: "[Operator note]\nrecall block" }] },
  ]);
});

it("maps user text and tool results", () => {
  expect(toGeminiSteps([
    { role: "user", parts: [{ type: "text", text: "hi" }] },
    { role: "user", parts: [{ type: "tool_result", callId: "c1", name: "web_search", content: "r", isError: true }] },
  ])).toEqual([
    { type: "user_input", content: [{ type: "text", text: "hi" }] },
    { type: "function_result", call_id: "c1", name: "web_search", result: "r", is_error: true },
  ]);
});

it("splices gemini raw steps verbatim", () => {
  const raw = [{ type: "thought", signature: "sig" }, { type: "function_call", id: "c1", name: "web_search", arguments: { query: "q" } }];
  expect(toGeminiSteps([{ role: "assistant", parts: [], raw: { provider: "gemini", data: raw } }])).toEqual(raw);
});

it("rebuilds from parts when raw is from another provider", () => {
  expect(toGeminiSteps([{
    role: "assistant",
    parts: [{ type: "text", text: "Looking." }, { type: "tool_call", id: "c1", name: "web_search", input: { query: "q" } }],
    raw: { provider: "anthropic", data: [{ type: "thinking" }] },
  }])).toEqual([
    { type: "model_output", content: [{ type: "text", text: "Looking." }] },
    { type: "function_call", id: "c1", name: "web_search", arguments: { query: "q" } },
  ]);
});

it("maps tools to function declarations", () => {
  expect(toGeminiTools([{ name: "web_search", description: "d", inputSchema: { type: "object" } }]))
    .toEqual([{ type: "function", name: "web_search", description: "d", parameters: { type: "object" } }]);
});

it("accumulates streamed steps: text, thought signature, and function arguments", () => {
  const acc = new StepAccumulator();
  acc.start(0, { type: "thought" });
  acc.delta(0, { type: "thought_signature", signature: "sig" });
  acc.start(1, { type: "model_output", content: [] });
  acc.delta(1, { type: "text", text: "Hel" });
  acc.delta(1, { type: "text", text: "lo" });
  acc.start(2, { type: "function_call", id: "c1", name: "web_search", arguments: {} });
  acc.delta(2, { type: "arguments_delta", arguments: '{"query":' });
  acc.delta(2, { type: "arguments_delta", arguments: '"neon"}' });
  expect(acc.steps()).toEqual([
    { type: "thought", signature: "sig" },
    { type: "model_output", content: [{ type: "text", text: "Hello" }] },
    { type: "function_call", id: "c1", name: "web_search", arguments: { query: "neon" } },
  ]);
});

import { GeminiProvider } from "../../src/llm/gemini.ts";

function fakeClient(create: (params: any, opts: any) => Promise<any>) {
  const calls: { params: any; opts: any }[] = [];
  return { calls, client: { interactions: { create: (params: any, opts: any) => { calls.push({ params, opts }); return create(params, opts); } } } };
}

const req = { system: "s", messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }], tools: [], effort: "low" as const };

async function drain(it: AsyncIterable<unknown>) { for await (const _ of it) { /* consume */ } }

it("fails with a clear error when Gemini sends nothing before the first-event timeout", async () => {
  const { client } = fakeClient(async (_p, opts) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise((_, reject) => opts.fetch_options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  }));
  const p = new GeminiProvider({ apiKey: "k", model: "gemini-test", client: client as any, firstEventTimeoutMs: 50 });
  const t0 = Date.now();
  await expect(drain(p.stream(req))).rejects.toThrow(/gemini-test did not respond within/);
  expect(Date.now() - t0).toBeLessThan(2000);
});

it("turns an overload error into a message that says what to do", async () => {
  const { client } = fakeClient(async () => { throw Object.assign(new Error('{"error":{"message":"gemini-test is currently experiencing high demand","code":"service_unavailable"}}'), { status: 503 }); });
  const p = new GeminiProvider({ apiKey: "k", model: "gemini-test", client: client as any, retryDelaysMs: [1, 1] });
  await expect(drain(p.stream(req))).rejects.toThrow(/gemini-test is overloaded.*GEMINI_MODEL/);
  await expect(p.completeJson({ system: "s", prompt: "p", schema: {} })).rejects.toThrow(/overloaded/);
});

it("turns off the SDK's own retries and passes an abort signal on every request", async () => {
  const { client, calls } = fakeClient(async () => ({ async *[Symbol.asyncIterator]() { yield { event_type: "interaction.completed", interaction: { status: "completed" } }; } }));
  const p = new GeminiProvider({ apiKey: "k", model: "gemini-test", client: client as any });
  await drain(p.stream(req));
  expect(calls[0].opts.retries).toEqual({ strategy: "none" }); // its retry re-sends a used body ("TypeError: unusable")
  expect(calls[0].opts.fetch_options.signal).toBeInstanceOf(AbortSignal);
});

const overloaded = () => Object.assign(new Error("gemini-test is currently experiencing high demand"), { status: 503 });

it("retries an overloaded request with a fresh call, then succeeds", async () => {
  let n = 0;
  const { client, calls } = fakeClient(async () => {
    if (n++ === 0) throw overloaded();
    return { output_text: '{"ok":true}', status: "completed" };
  });
  const p = new GeminiProvider({ apiKey: "k", model: "gemini-test", client: client as any, retryDelaysMs: [1, 1] });
  expect(await p.completeJson({ system: "s", prompt: "p", schema: {} })).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
});

it("does not retry errors other than overload", async () => {
  const { client, calls } = fakeClient(async () => { throw Object.assign(new Error("API key not valid"), { status: 400 }); });
  const p = new GeminiProvider({ apiKey: "k", model: "gemini-test", client: client as any, retryDelaysMs: [1, 1] });
  await expect(p.completeJson({ system: "s", prompt: "p", schema: {} })).rejects.toThrow(/API key not valid/);
  expect(calls).toHaveLength(1);
});
