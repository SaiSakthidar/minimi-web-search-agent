import type { Msg } from "../../src/llm/types.ts";

/**
 * Anthropic's request rules for a messages array, checked provider-neutrally:
 * a system message never comes first, follows a user message, and is last or followed by an assistant turn;
 * no assistant message is empty; every tool call is answered by the next user message; no assistant prefill at the end.
 */
export function wireViolations(messages: Msg[]): string[] {
  const out: string[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1], next = messages[i + 1];
    if (m.role === "system") {
      if (i === 0) out.push(`system at index 0`);
      else if (prev.role !== "user") out.push(`system at ${i} follows ${prev.role}`);
      if (next && next.role !== "assistant") out.push(`system at ${i} followed by ${next.role}`);
    }
    if (m.role === "assistant") {
      if (m.parts.length === 0) out.push(`empty assistant at ${i}`);
      const calls = m.parts.filter((p) => p.type === "tool_call").map((p) => (p as { id: string }).id);
      if (calls.length) {
        const answered = next?.role === "user" ? next.parts.filter((p) => p.type === "tool_result").map((p) => (p as { callId: string }).callId) : [];
        for (const id of calls) if (!answered.includes(id)) out.push(`unanswered tool call ${id} at ${i}`);
      }
      if (!next) out.push(`assistant prefill at end`);
    }
  });
  return out;
}
