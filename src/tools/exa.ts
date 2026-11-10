// Exa implementation of SearchProvider: query-matched highlights and published
// dates in one call; page text for JS-rendered pages via getContents.

import { Exa } from "exa-js";
import type { RawResult, SearchProvider } from "./types.ts";

export class ExaProvider implements SearchProvider {
  private exa: Exa;
  constructor(apiKey: string) { this.exa = new Exa(apiKey); }

  async search(q: { query: string; numResults: number; publishedAfter?: string }): Promise<RawResult[]> {
    const res = await this.exa.search(q.query, {
      type: "auto",
      numResults: q.numResults,
      ...(q.publishedAfter ? { startPublishedDate: q.publishedAfter } : {}),
      contents: { highlights: { maxCharacters: 1200, query: q.query } },
    });
    return res.results.map((r) => ({
      title: r.title ?? null,
      url: r.url,
      publishedDate: r.publishedDate ?? undefined,
      highlights: (r as { highlights?: string[] }).highlights ?? [],
    }));
  }

  async contents(url: string): Promise<{ text: string; publishedDate?: string } | null> {
    const res = await this.exa.getContents(url, { text: { maxCharacters: 40000 } });
    const r = res.results[0] as { text?: string; publishedDate?: string } | undefined;
    if (!r?.text) return null;
    return { text: r.text, publishedDate: r.publishedDate ?? undefined };
  }
}
