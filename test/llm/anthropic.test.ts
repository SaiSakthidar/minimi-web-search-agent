import { expect, it } from "vitest";
import { afterLastFallback, mapStop, toAnthropicMessages, toAnthropicTools } from "../../src/llm/anthropic.ts";

it("replays anthropic raw content verbatim", () => {
  const out = toAnthropicMessages([{
    role: "assistant", parts: [{ type: "text", text: "x" }],
    raw: { provider: "anthropic", data: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "x" }] },
  }]);
  expect(out[0]).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "x" }] });
});

it("rebuilds from parts when raw is from another provider", () => {
  const out = toAnthropicMessages([{
    role: "assistant",
    parts: [{ type: "text", text: "Looking." }, { type: "tool_call", id: "c1", name: "web_search", input: { query: "neon" } }],
    raw: { provider: "gemini", data: [{ type: "thought", signature: "g" }] },
  }]);
  expect(out[0].content).toEqual([
    { type: "text", text: "Looking." },
    { type: "tool_use", id: "c1", name: "web_search", input: { query: "neon" } },
  ]);
});

it("maps tool results to tool_result blocks with tool_use_id", () => {
  const out = toAnthropicMessages([{ role: "user", parts: [
    { type: "tool_result", callId: "c1", name: "web_search", content: "results", isError: false },
    { type: "tool_result", callId: "c2", name: "fetch_url", content: "boom", isError: true },
  ] }]);
  expect(out[0]).toEqual({ role: "user", content: [
    { type: "tool_result", tool_use_id: "c1", content: "results", is_error: false },
    { type: "tool_result", tool_use_id: "c2", content: "boom", is_error: true },
  ] });
});

it("maps system Msg to a system-role message entry", () => {
  expect(toAnthropicMessages([{ role: "system", text: "recall block" }])).toEqual([{ role: "system", content: "recall block" }]);
});

it("drops empty text parts when rebuilding", () => {
  const out = toAnthropicMessages([{ role: "assistant", parts: [{ type: "text", text: "" }, { type: "tool_call", id: "c", name: "t", input: {} }] }]);
  expect(out[0].content).toHaveLength(1);
});

it("marks tools strict only when the schema is closed", () => {
  const [a, b] = toAnthropicTools([
    { name: "a", description: "A", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
    { name: "b", description: "B", inputSchema: { type: "object", properties: {} } },
  ]);
  expect(a).toMatchObject({ name: "a", description: "A", strict: true, input_schema: { type: "object" } });
  expect(b.strict).toBeUndefined();
});

it("keeps only content after the last fallback block", () => {
  const content = [
    { type: "tool_use", id: "dead", name: "web_search", input: {} },
    { type: "fallback", from: { model: "a" }, to: { model: "b" } },
    { type: "text", text: "ok" },
  ];
  expect(afterLastFallback(content)).toEqual(content.slice(1));
  expect(afterLastFallback([{ type: "text", text: "plain" }])).toEqual([{ type: "text", text: "plain" }]);
});

it("maps stop reasons", () => {
  expect(mapStop("end_turn")).toBe("end");
  expect(mapStop("tool_use")).toBe("tool_calls");
  expect(mapStop("pause_turn")).toBe("tool_calls");
  expect(mapStop("max_tokens")).toBe("max_tokens");
  expect(mapStop("model_context_window_exceeded")).toBe("max_tokens");
  expect(mapStop("refusal")).toBe("refusal");
});
