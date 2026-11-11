// Anthropic Messages API behind LlmProvider. Streams through the beta endpoint
// so server-side refusal fallbacks are on; everything provider-specific
// (thinking replay, fallback boundaries, cache control) stays in this file.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaAssistantMessageParam, BetaContentBlock, BetaMessageParam, BetaTool, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { JsonRequest, LlmEvent, LlmProvider, Msg, StopReason, StreamRequest, ToolSpec } from "./types.ts";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function toAnthropicMessages(messages: Msg[]): BetaMessageParam[] {
  return messages.map((m): BetaMessageParam => {
    if (m.role === "system") return { role: "system", content: m.text };
    if (m.role === "user") {
      return {
        role: "user",
        content: m.parts.map((p) => p.type === "text"
          ? { type: "text" as const, text: p.text }
          : { type: "tool_result" as const, tool_use_id: p.callId, content: p.content, is_error: p.isError ?? false }),
      };
    }
    if (m.raw?.provider === "anthropic") return { role: "assistant", content: m.raw.data as BetaAssistantMessageParam["content"] };
    return {
      role: "assistant",
      content: m.parts
        .filter((p) => p.type !== "text" || p.text.length > 0)
        .map((p) => p.type === "text"
          ? { type: "text" as const, text: p.text }
          : { type: "tool_use" as const, id: p.id, name: p.name, input: p.input as Record<string, unknown> }),
    };
  });
}

export function toAnthropicTools(tools: ToolSpec[]): BetaTool[] {
  return tools.map((t) => {
    const closed = t.inputSchema.additionalProperties === false && Array.isArray(t.inputSchema.required);
    return {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool["input_schema"],
      ...(closed ? { strict: true } : {}),
    };
  });
}

/** Blocks before the final `fallback` block came from a model that declined; they are neither run nor replayed. */
export function afterLastFallback<T extends { type: string }>(content: T[]): T[] {
  const i = content.map((b) => b.type).lastIndexOf("fallback");
  return i < 0 ? content : content.slice(i);
}

export function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use": case "pause_turn": return "tool_calls";
    case "max_tokens": case "model_context_window_exceeded": return "max_tokens";
    case "refusal": return "refusal";
    default: return "end";
  }
}

/**
 * Two cache breakpoints: the frozen system prompt, and a top-level marker that caches the whole conversation
 * up to its last block, so each new round of a long session pays only for what was added.
 */
export function buildStreamParams(req: StreamRequest, model: string): MessageCreateParamsStreaming {
  return {
    model,
    max_tokens: 16000,
    stream: true,
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive" },
    output_config: { effort: req.effort },
    tools: toAnthropicTools(req.tools),
    messages: toAnthropicMessages(req.messages),
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  readonly modelLabel: string;
  private client: Anthropic;
  private chatModel: string;
  private jsonModel: string;
  private fallbacksSupported = true;

  constructor(opts: { apiKey: string; chatModel?: string; jsonModel?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.chatModel = opts.chatModel || "claude-opus-5-5";
    this.jsonModel = opts.jsonModel || "claude-haiku-5-5";
    this.modelLabel = this.chatModel;
  }

  async *stream(req: StreamRequest): AsyncIterable<LlmEvent> {
    const params = buildStreamParams(req, this.chatModel);
    let stream = this.open(params, req.signal);
    let started = false;
    try {
      for await (const ev of stream) {
        started = true;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text", delta: ev.delta.text };
      }
    } catch (e) {
      // An API that rejects the fallback beta fails before any event; retry once without it.
      const aboutFallbacks = e instanceof Anthropic.BadRequestError && /fallback|server-side-fallback|beta/i.test(e.message);
      if (started || !this.fallbacksSupported || !aboutFallbacks) throw e;
      console.warn(`[anthropic] fallbacks rejected (${e.message}); continuing without them`);
      this.fallbacksSupported = false;
      stream = this.open(params, req.signal);
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text", delta: ev.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const content = afterLastFallback(final.content as BetaContentBlock[]);
    for (const b of content) if (b.type === "tool_use") yield { type: "tool_call", id: b.id, name: b.name, input: b.input };
    yield { type: "done", stop: mapStop(final.stop_reason), raw: { provider: "anthropic", data: content } };
  }

  private open(params: MessageCreateParamsStreaming, signal?: AbortSignal) {
    const body = this.fallbacksSupported ? { ...params, betas: [FALLBACK_BETA], fallbacks: "default" as const } : params;
    return this.client.beta.messages.stream(body, { signal });
  }

  async completeJson<T>(req: JsonRequest): Promise<T> {
    const msg = await this.client.messages.create({
      model: this.jsonModel,
      max_tokens: 4000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { format: { type: "json_schema", schema: req.schema } },
    });
    if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") throw new Error(`completeJson stopped: ${msg.stop_reason}`);
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return JSON.parse(text) as T;
  }
}
