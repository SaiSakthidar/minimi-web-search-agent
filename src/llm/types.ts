// Provider-neutral message model. The agent loop speaks only these types;
// each provider file maps them to and from its SDK.

export type ProviderName = "anthropic" | "gemini" | "fake";

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "tool_call"; id: string; name: string; input: unknown };
export type ToolResultPart = { type: "tool_result"; callId: string; name: string; content: string; isError?: boolean };

/** Provider-native assistant content, replayed only to the provider that produced it. */
export type Raw = { provider: ProviderName; data: unknown };

export type Msg =
  | { role: "system"; text: string }
  | { role: "user"; parts: (TextPart | ToolResultPart)[] }
  | { role: "assistant"; parts: (TextPart | ToolCallPart)[]; raw?: Raw };

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type Effort = "low" | "medium" | "high";
export type StopReason = "end" | "tool_calls" | "max_tokens" | "refusal";

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; stop: StopReason; raw?: Raw };

export type StreamRequest = { system: string; messages: Msg[]; tools: ToolSpec[]; effort: Effort; signal?: AbortSignal };
export type JsonRequest = { system: string; prompt: string; schema: Record<string, unknown> };

export interface LlmProvider {
  readonly name: ProviderName;
  /** Shown in the UI header, e.g. "claude-opus-5-5". */
  readonly modelLabel: string;
  stream(req: StreamRequest): AsyncIterable<LlmEvent>;
  completeJson<T>(req: JsonRequest): Promise<T>;
}
