// Gemini over the Interactions API, stateless (store: false): the full step
// history is sent each round and the model's own steps (thoughts with
// signatures, outputs, function calls) are kept in `raw` for exact replay.

import { GoogleGenAI, type Interactions } from "@google/genai";
import type { JsonRequest, LlmEvent, LlmProvider, Msg, StreamRequest, ToolSpec } from "./types.ts";

type Step = Interactions.Step;
type AnyObj = Record<string, any>;

export function toGeminiSteps(messages: Msg[]): Step[] {
  const out: Step[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ type: "user_input", content: [{ type: "text", text: `[Operator note]\n${m.text}` }] });
    } else if (m.role === "user") {
      const texts = m.parts.flatMap((p) => (p.type === "text" ? [{ type: "text" as const, text: p.text }] : []));
      if (texts.length) out.push({ type: "user_input", content: texts });
      for (const p of m.parts) {
        if (p.type === "tool_result") out.push({ type: "function_result", call_id: p.callId, name: p.name, result: p.content, is_error: p.isError ?? false });
      }
    } else if (m.raw?.provider === "gemini") {
      out.push(...(m.raw.data as Step[]));
    } else {
      const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      if (text) out.push({ type: "model_output", content: [{ type: "text", text }] });
      for (const p of m.parts) {
        if (p.type === "tool_call") out.push({ type: "function_call", id: p.id, name: p.name, arguments: (p.input ?? {}) as AnyObj });
      }
    }
  }
  return out;
}

export function toGeminiTools(tools: ToolSpec[]): Interactions.Function[] {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }));
}

/** Rebuilds the model's steps from step.start + step.delta events (step.stop carries no step). */
export class StepAccumulator {
  private byIndex = new Map<number, { step: AnyObj; args: string }>();

  start(index: number, step: AnyObj): void {
    this.byIndex.set(index, { step: structuredClone(step), args: "" });
  }

  delta(index: number, d: AnyObj): void {
    const slot = this.byIndex.get(index);
    if (!slot) return;
    const s = slot.step;
    if (d.type === "text") {
      s.content ??= [];
      const last = s.content.at(-1);
      if (last?.type === "text") last.text += d.text;
      else s.content.push({ type: "text", text: d.text });
    } else if (d.type === "thought_signature" && d.signature) {
      s.signature = (s.signature ?? "") + d.signature;
    } else if (d.type === "thought_summary" && d.content) {
      s.summary = [...(s.summary ?? []), d.content];
    } else if (d.type === "arguments_delta" && d.arguments) {
      slot.args += d.arguments;
    }
  }

  steps(): Step[] {
    return [...this.byIndex.entries()].sort(([a], [b]) => a - b).map(([, { step, args }]) => {
      if (step.type === "function_call" && args) {
        try { step.arguments = JSON.parse(args); } catch { /* keep whatever step.start carried */ }
      }
      return step as Step;
    });
  }
}

const THINKING = { low: "low", medium: "medium", high: "high" } as const;

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  readonly modelLabel: string;
  private ai: GoogleGenAI;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model || "gemini-3.8-flash";
    this.modelLabel = this.model;
  }

  async *stream(req: StreamRequest): AsyncIterable<LlmEvent> {
    const stream = await this.ai.interactions.create({
      model: this.model,
      input: toGeminiSteps(req.messages),
      system_instruction: req.system,
      ...(req.tools.length ? { tools: toGeminiTools(req.tools) } : {}),
      store: false,
      stream: true,
      generation_config: { thinking_level: THINKING[req.effort] },
    });
    const acc = new StepAccumulator();
    let status = "completed";
    for await (const ev of stream as AsyncIterable<AnyObj>) {
      if (req.signal?.aborted) throw new Error("aborted");
      switch (ev.event_type) {
        case "step.start": acc.start(ev.index, ev.step); break;
        case "step.delta":
          acc.delta(ev.index, ev.delta);
          if (ev.delta.type === "text" && ev.delta.text) yield { type: "text", delta: ev.delta.text };
          break;
        case "interaction.completed": status = ev.interaction?.status ?? status; break;
        case "error": throw new Error(`Gemini error: ${ev.error?.message ?? "unknown"}`);
      }
    }
    if (status === "failed" || status === "cancelled") throw new Error(`Gemini interaction ${status}`);
    const steps = acc.steps();
    const calls = steps.filter((s): s is Interactions.FunctionCallStep => s.type === "function_call");
    for (const c of calls) yield { type: "tool_call", id: c.id, name: c.name, input: c.arguments };
    const stop = status === "incomplete" || status === "budget_exceeded" ? "max_tokens" : calls.length ? "tool_calls" : "end";
    yield { type: "done", stop, raw: { provider: "gemini", data: steps } };
  }

  async completeJson<T>(req: JsonRequest): Promise<T> {
    const interaction = await this.ai.interactions.create({
      model: this.model,
      input: req.prompt,
      system_instruction: req.system,
      store: false,
      response_format: { type: "text", mime_type: "application/json", schema: req.schema },
    });
    if (!interaction.output_text) throw new Error(`completeJson: empty output (status ${interaction.status})`);
    return JSON.parse(interaction.output_text) as T;
  }
}
