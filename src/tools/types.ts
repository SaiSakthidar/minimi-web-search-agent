import type { ToolSpec } from "../llm/types.ts";

export type RawResult = { title: string | null; url: string; publishedDate?: string; highlights: string[] };

/** The web backend. Swapping Exa for another API means one new implementation of this. */
export interface SearchProvider {
  search(q: { query: string; numResults: number; publishedAfter?: string }): Promise<RawResult[]>;
  contents(url: string): Promise<{ text: string; publishedDate?: string } | null>;
}

export type SourceRef = { id: number; title: string; url: string; publishedDate: string | null };

/** Per-turn state shared by the tools: call counters for the caps and the numbered sources list. */
export type TurnContext = { searchCalls: number; fetchCalls: number; sources: SourceRef[]; onStatus(text: string): void };

export type ToolHandler = { spec: ToolSpec; run(input: unknown, ctx: TurnContext): Promise<{ content: string; isError?: boolean }> };

export function newTurnContext(onStatus: (text: string) => void = () => {}): TurnContext {
  return { searchCalls: 0, fetchCalls: 0, sources: [], onStatus };
}
