// web_search: one call to the search provider, shaped for the model.
// Dated passages, syndicated copies collapsed, undated first then oldest to
// newest so the freshest evidence sits closest to the model's next step.

import { tokenize } from "../text.ts";
import type { RawResult, SearchProvider, SourceRef, ToolHandler } from "./types.ts";

export const SEARCH_CAP = 6;
const MAX_HIGHLIGHTS = 3;
const HIGHLIGHT_CHARS = 400;

const DESCRIPTION =
  "Search the live web. Returns numbered results with url, published date (or 'undated'), and the passages most " +
  "relevant to the query. Cite results by their [n]. Use one call per fact; for comparisons, call once per item in " +
  "parallel. For 'has it changed since X' questions, set publishedAfter to X.";

const day = (d?: string) => (d ? d.slice(0, 10) : null);

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** The name a site is registered under: neon.com -> neon, blog.hubspot.com -> hubspot, www.ocado.co.uk -> ocado. */
export function siteName(url: string): string {
  const labels = new URL(url).hostname.toLowerCase().split(".");
  const n = labels.length;
  if (n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2])) return labels[n - 3];
  return labels[n - 2] ?? labels[0];
}

export function prepareResults(raw: RawResult[], startId: number, query = ""): { sources: SourceRef[]; rendered: string } {
  const named = new Set(tokenize(query));
  const seen: string[] = [];
  const unique = raw.filter((r) => {
    const key = [...new Set(tokenize(r.title ?? ""))].sort().join(" ") || r.url; // no usable title words: never a duplicate
    if (seen.includes(key)) return false;
    seen.push(key);
    return true;
  });
  const sorted = unique
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const da = day(a.r.publishedDate), db = day(b.r.publishedDate);
      if (!da || !db) return da === db ? a.i - b.i : da ? 1 : -1;
      return da.localeCompare(db) || a.i - b.i;
    })
    .map((x) => x.r);

  const sources: SourceRef[] = [];
  const blocks: string[] = [];
  sorted.forEach((r, i) => {
    const s: SourceRef = { id: startId + i, title: r.title?.trim() || new URL(r.url).hostname, url: r.url, publishedDate: day(r.publishedDate) };
    sources.push(s);
    const hl = r.highlights.slice(0, MAX_HIGHLIGHTS).map((h) => `- ${h.replace(/\s+/g, " ").trim().slice(0, HIGHLIGHT_CHARS)}`);
    const official = named.has(siteName(s.url)) ? ["official site"] : [];
    blocks.push([`[${s.id}] ${s.title}`, `url: ${s.url}`, `date: ${s.publishedDate ?? "undated"}`, ...official, ...hl].join("\n"));
  });
  return { sources, rendered: blocks.join("\n\n") };
}

export function searchTool(provider: SearchProvider): ToolHandler {
  return {
    spec: {
      name: "web_search",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Short search query. Start broad, then narrow." },
          publishedAfter: { type: "string", description: "YYYY-MM-DD; only results published after this" },
          numResults: { type: "integer", description: "How many results, 3 to 10 (default 8)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async run(input, ctx) {
      const { query, publishedAfter, numResults } = (input ?? {}) as { query?: unknown; publishedAfter?: unknown; numResults?: unknown };
      if (typeof query !== "string" || !query.trim()) return { isError: true, content: "web_search needs a non-empty 'query' string." };
      ctx.searchCalls++;
      if (ctx.searchCalls > SEARCH_CAP) {
        return { isError: true, content: "Search cap reached for this turn. Answer with what you have and say what you could not verify." };
      }
      const after = typeof publishedAfter === "string" && /^\d{4}-\d{2}-\d{2}/.test(publishedAfter) ? publishedAfter.slice(0, 10) : undefined;
      const n = typeof numResults === "number" ? Math.min(10, Math.max(3, Math.round(numResults))) : 8;
      ctx.onStatus(`searching: ${query}${after ? ` since ${after}` : ""}`);
      let raw: RawResult[];
      try {
        raw = await provider.search({ query, numResults: n, ...(after ? { publishedAfter: after } : {}) });
      } catch (e) {
        return { isError: true, content: `Search failed: ${(e as Error).message}. Try a different query or answer with what you have.` };
      }
      if (raw.length === 0) return { content: `No results for "${query}"${after ? ` published after ${after}` : ""}.` };
      const { sources, rendered } = prepareResults(raw, ctx.sources.length + 1, query);
      ctx.sources.push(...sources);
      return { content: rendered };
    },
  };
}
