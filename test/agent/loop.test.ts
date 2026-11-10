import { expect, it } from "vitest";
import { MAX_ROUNDS, runTurn, splitDiff, type TurnEvent } from "../../src/agent/loop.ts";
import { DIFF_FENCE, lastRoundNote, pickEffort, systemPrompt } from "../../src/agent/prompt.ts";
import type { Msg } from "../../src/llm/types.ts";
import type { ToolHandler } from "../../src/tools/types.ts";
import { fakeProvider } from "../helpers/fakeProvider.ts";

const userMsg = (text: string): Msg => ({ role: "user", parts: [{ type: "text", text }] });

function stubTool(name: string, log: string[] = []): ToolHandler {
  return {
    spec: { name, description: name, inputSchema: { type: "object" } },
    async run(input, ctx) {
      log.push(JSON.stringify(input));
      ctx.onStatus(`${name}: ${JSON.stringify(input)}`);
      ctx.sources.push({ id: ctx.sources.length + 1, title: name, url: `https://${name}.test`, publishedDate: null });
      return { content: `result for ${JSON.stringify(input)}` };
    },
  };
}

async function run(script: Parameters<typeof fakeProvider>[0], history: Msg[] = [userMsg("q")], tools = [stubTool("web_search")]) {
  const provider = fakeProvider(script);
  const events: TurnEvent[] = [];
  const result = await runTurn({ provider, system: "sys", history, tools, effort: "medium", onEvent: (e) => events.push(e) });
  const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  return { provider, events, result, text };
}

it("runs parallel tool calls and feeds all results in one user message", async () => {
  const { result, events } = await run([
    { text: "Checking.", toolCalls: [{ name: "web_search", input: { query: "a" } }, { name: "web_search", input: { query: "b" } }] },
    { text: "Both found [1][2]." },
  ]);
  expect(result.newMessages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
  const toolMsg = result.newMessages[1] as Extract<Msg, { role: "user" }>;
  expect(toolMsg.parts).toHaveLength(2);
  expect(toolMsg.parts.map((p) => p.type === "tool_result" && p.callId)).toEqual(["call-1", "call-2"]);
  expect(events.filter((e) => e.type === "status")).toHaveLength(2);
  expect(result.sources).toHaveLength(2);
  expect(result.rounds).toBe(2);
});

it("stops after MAX_ROUNDS with the last-round note and no tools", async () => {
  const call = { toolCalls: [{ name: "web_search", input: { query: "x" } }] };
  const { provider, result } = await run([call, call, call, { text: "Final answer.", ...call }, call]);
  expect(provider.calls).toHaveLength(MAX_ROUNDS);
  const last = provider.calls[MAX_ROUNDS - 1];
  expect(last.tools).toEqual([]);
  expect(last.messages.at(-1)).toEqual({ role: "system", text: lastRoundNote() });
  const finalMsg = result.newMessages.at(-1) as Extract<Msg, { role: "assistant" }>;
  expect(finalMsg.parts.every((p) => p.type === "text")).toBe(true);
  expect(finalMsg.raw).toBeUndefined();
  expect(result.text).toBe("Final answer.");
});

it("strips raw from another provider before sending", async () => {
  const history: Msg[] = [
    userMsg("earlier"),
    { role: "assistant", parts: [{ type: "text", text: "old" }], raw: { provider: "gemini", data: [{ type: "thought" }] } },
    { role: "assistant", parts: [{ type: "text", text: "same" }], raw: { provider: "fake", data: { n: 0 } } },
    userMsg("now"),
  ];
  const { provider } = await run([{ text: "ok" }], history);
  const sent = provider.calls[0].messages.filter((m) => m.role === "assistant") as Extract<Msg, { role: "assistant" }>[];
  expect(sent[0].raw).toBeUndefined();
  expect(sent[1].raw).toEqual({ provider: "fake", data: { n: 0 } });
  expect((history[1] as any).raw).toBeDefined(); // the caller's history is not mutated
});

it("splits a well-formed diff fence into a diff event and keeps prose", async () => {
  const items = [{ item: "Neon Launch", before: "$19/mo", beforeDate: "2026-11-03", after: "$24/mo", afterDate: "2026-11-07", verdict: "changed", source: 1 }];
  const { events, text, result } = await run([{ text: `Neon raised Launch [1].\n\n${DIFF_FENCE}\n${JSON.stringify({ items })}\n\`\`\`\n` }]);
  expect(text).toBe("Neon raised Launch [1].\n\n");
  expect(events.find((e) => e.type === "diff")).toEqual({ type: "diff", items });
  expect(result.text).toBe("Neon raised Launch [1].");
  expect(result.diff).toEqual(items);
});

it("streams the whole prose when the fence is missing or malformed", async () => {
  const plain = await run([{ text: "No changes found [1]." }]);
  expect(plain.text).toBe("No changes found [1].");
  expect(plain.events.some((e) => e.type === "diff")).toBe(false);
  const broken = await run([{ text: `Neon changed [1].\n${DIFF_FENCE}\n{ "items": [ oops \n\`\`\`` }]);
  expect(broken.text).toBe("Neon changed [1].\n");
  expect(broken.events.some((e) => e.type === "diff")).toBe(false);
  expect(broken.result.text).toBe("Neon changed [1].");
  expect(broken.result.diff).toBeNull();
});

it("emits a notice and stops on max_tokens", async () => {
  const { events, provider } = await run([{ text: "Partial", stop: "max_tokens" }, { text: "never" }]);
  expect(events.at(-1)).toEqual({ type: "notice", text: "The answer was cut short." });
  expect(provider.calls).toHaveLength(1);
});

it("emits a notice on refusal", async () => {
  const { events } = await run([{ stop: "refusal" }]);
  expect(events).toContainEqual({ type: "notice", text: "The model declined to answer this." });
});

it("returns an error tool_result for an unknown tool or a throwing tool", async () => {
  const boom: ToolHandler = { spec: { name: "boom", description: "", inputSchema: {} }, async run() { throw new Error("kaput"); } };
  const { result } = await run([
    { toolCalls: [{ name: "nope", input: {} }, { name: "boom", input: {} }] },
    { text: "done" },
  ], [userMsg("q")], [boom]);
  const parts = (result.newMessages[1] as Extract<Msg, { role: "user" }>).parts;
  expect(parts.map((p) => p.type === "tool_result" && p.isError)).toEqual([true, true]);
  expect(parts[1].type === "tool_result" && parts[1].content).toContain("kaput");
});

it("splitDiff fills missing fields and drops non-object items", () => {
  const { diff, prose } = splitDiff(`Text.\n${DIFF_FENCE}\n{"items":[{"item":"A","verdict":"weird"}, 3]}\n\`\`\``);
  expect(prose).toBe("Text.");
  expect(diff).toEqual([{ item: "A", before: null, beforeDate: null, after: null, afterDate: null, verdict: "unverified", source: null }]);
});

it("pickEffort is low for short chit-chat and medium otherwise", () => {
  expect(pickEffort("hi there")).toBe("low");
  expect(pickEffort("thanks!")).toBe("low");
  expect(pickEffort("What did I ask you on 3 November?")).toBe("medium");
  expect(pickEffort("Has Neon pricing changed")).toBe("medium");
  expect(pickEffort("Tell me everything you know about the history of managed database services in the cloud")).toBe("medium");
});

it("systemPrompt states today's date on its final line and the diff contract", () => {
  const p = systemPrompt({ today: "2026-11-10", providerLabel: "fake-model" });
  expect(p.trim().split("\n").at(-1)).toContain("2026-11-10");
  expect(p).toContain(DIFF_FENCE);
  expect(p).toContain("publishedAfter");
  expect(p).not.toMatch(/training (data|cutoff)/i);
});
