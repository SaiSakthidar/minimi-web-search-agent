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
  "relevant to the query. Cite results by their [n]. Put every query you need right now in one call: for a comparison " +
  "or a re-check of N items, pass N queries together. For 'has it changed since X' questions, set publishedAfter to X.";

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
          queries: {
            type: "array",
            items: { type: "string" },
            description: "One or more short queries, searched in parallel. Comparing N things: one query per thing, in this one call.",
          },
          publishedAfter: { type: "string", description: "YYYY-MM-DD; only results published after this" },
          numResults: { type: "integer", description: "Results per query, 3 to 10 (default 8 for one query, 5 for several)" },
        },
        required: ["queries"],
        additionalProperties: false,
      },
    },
    async run(input, ctx) {
      const { queries, query, publishedAfter, numResults } = (input ?? {}) as { queries?: unknown; query?: unknown; publishedAfter?: unknown; numResults?: unknown };
      const asked = (Array.isArray(queries) ? queries : [query])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim());
      if (asked.length === 0) return { isError: true, content: "web_search needs at least one non-empty query in 'queries'." };
      const room = Math.max(0, SEARCH_CAP - ctx.searchCalls);
      if (room === 0) {
        ctx.searchCalls++;
        return { isError: true, content: "Search cap reached for this turn. Answer with what you have and say what you could not verify." };
      }
      const run = asked.slice(0, room);
      const skipped = asked.slice(room);
      ctx.searchCalls += run.length;

      const after = typeof publishedAfter === "string" && /^\d{4}-\d{2}-\d{2}/.test(publishedAfter) ? publishedAfter.slice(0, 10) : undefined;
      const n = typeof numResults === "number" ? Math.min(10, Math.max(3, Math.round(numResults))) : run.length > 1 ? 5 : 8;
      for (const q of run) ctx.onStatus(`searching: ${q}${after ? ` since ${after}` : ""}`);
      const settled = await Promise.allSettled(run.map((q) => provider.search({ query: q, numResults: n, ...(after ? { publishedAfter: after } : {}) })));

      const raw: RawResult[] = [];
      const notes: string[] = [];
      settled.forEach((res, i) => {
        if (res.status === "fulfilled") {
          raw.push(...res.value);
          if (res.value.length === 0) notes.push(`No results for "${run[i]}"${after ? ` published after ${after}` : ""}.`);
        } else notes.push(`Search failed for "${run[i]}": ${(res.reason as Error)?.message ?? res.reason}.`);
      });
      if (skipped.length) notes.push(`Skipped (search cap): ${skipped.join("; ")}.`);
      if (raw.length === 0) {
        const allFailed = settled.every((x) => x.status === "rejected");
        return { ...(allFailed ? { isError: true } : {}), content: [...notes, allFailed ? "Try different queries or answer with what you have." : ""].filter(Boolean).join("\n") };
      }
      const seen = new Set<string>();
      const unique = raw.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
      const { sources, rendered } = prepareResults(unique, ctx.sources.length + 1, run.join(" "));
      ctx.sources.push(...sources);
      return { content: [rendered, ...notes].join("\n\n") };
    },
  };
}
