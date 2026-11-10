import { expect, it } from "vitest";
import { prepareResults, searchTool, SEARCH_CAP } from "../../src/tools/search.ts";
import { newTurnContext, type RawResult, type SearchProvider } from "../../src/tools/types.ts";

const r = (title: string, url: string, publishedDate?: string, highlights = ["h"]): RawResult => ({ title, url, publishedDate, highlights });

function fakeSearch(results: RawResult[][]): SearchProvider & { queries: any[] } {
  const queries: any[] = [];
  return {
    queries,
    async search(q) { queries.push(q); return results.shift() ?? []; },
    async contents() { return null; },
  };
}

it("labels undated results and sorts them first, then oldest to newest", () => {
  const { sources, rendered } = prepareResults([
    r("Neon pricing update", "https://neon.tech/blog", "2026-11-07T00:00:00.000Z"),
    r("Railway pricing", "https://railway.com/pricing"),
    r("Supabase pricing", "https://supabase.com/pricing", "2026-10-30T00:00:00.000Z"),
  ], 1);
  expect(sources.map((s) => s.title)).toEqual(["Railway pricing", "Supabase pricing", "Neon pricing update"]);
  expect(sources.map((s) => s.id)).toEqual([1, 2, 3]);
  expect(sources[0].publishedDate).toBeNull();
  expect(rendered).toContain("[1] Railway pricing\nurl: https://railway.com/pricing\ndate: undated\n- h");
  expect(rendered).toContain("date: 2026-11-07");
});

it("collapses syndicated duplicates by title", () => {
  const { sources } = prepareResults([
    r("Acme raises prices for Pro plan", "https://a.com/x", "2026-11-01"),
    r("Acme Raises Prices for Pro Plan!", "https://b.com/y", "2026-11-02"),
    r("Something else", "https://c.com/z", "2026-11-03"),
  ], 1);
  expect(sources.map((s) => s.url)).toEqual(["https://a.com/x", "https://c.com/z"]);
});

it("trims to 3 highlights of at most 400 characters", () => {
  const { rendered } = prepareResults([r("T", "https://t.com", "2026-11-01", ["a".repeat(900), "b", "c", "d"])], 1);
  expect(rendered).not.toContain("- d");
  expect(rendered).not.toContain("a".repeat(401));
});

it("numbers sources continuing from the turn context", async () => {
  const tool = searchTool(fakeSearch([
    [r("A", "https://a.com", "2026-11-01"), r("B", "https://b.com", "2026-11-02"), r("C", "https://c.com", "2026-11-03")],
    [r("D", "https://d.com", "2026-11-04")],
  ]));
  const ctx = newTurnContext();
  await tool.run({ query: "first" }, ctx);
  const second = await tool.run({ query: "second" }, ctx);
  expect(second.content).toContain("[4] D");
  expect(ctx.sources.map((s) => s.id)).toEqual([1, 2, 3, 4]);
});

it("returns an error result past the cap", async () => {
  const tool = searchTool(fakeSearch([]));
  const ctx = newTurnContext();
  ctx.searchCalls = SEARCH_CAP;
  const out = await tool.run({ query: "x" }, ctx);
  expect(out.isError).toBe(true);
  expect(out.content).toContain("Search cap reached");
});

it("passes publishedAfter and numResults through, defaulting numResults to 8, and reports status", async () => {
  const provider = fakeSearch([[], []]);
  const tool = searchTool(provider);
  const statuses: string[] = [];
  const ctx = newTurnContext((s) => statuses.push(s));
  await tool.run({ query: "neon pricing", publishedAfter: "2026-11-03" }, ctx);
  await tool.run({ query: "supabase", numResults: 5 }, ctx);
  expect(provider.queries).toEqual([
    { query: "neon pricing", numResults: 8, publishedAfter: "2026-11-03" },
    { query: "supabase", numResults: 5 },
  ]);
  expect(statuses).toEqual(["searching: neon pricing since 2026-11-03", "searching: supabase"]);
});

it("returns an error result when the provider throws, or the query is missing", async () => {
  const tool = searchTool({ async search() { throw new Error("429 rate limited"); }, async contents() { return null; } });
  expect(await tool.run({ query: "x" }, newTurnContext())).toMatchObject({ isError: true });
  expect(await tool.run({}, newTurnContext())).toMatchObject({ isError: true });
});

it("says so when there are no results", async () => {
  const out = await searchTool(fakeSearch([[]])).run({ query: "zzz" }, newTurnContext());
  expect(out.content).toMatch(/No results/);
});
