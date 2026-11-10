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
