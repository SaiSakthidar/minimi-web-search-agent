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

it("tags a result as the official site when its domain name is a product named in the query", () => {
  const { rendered } = prepareResults([
    r("Neon pricing", "https://neon.com/pricing", "2026-11-01"),
    r("Neon vs Supabase", "https://neon-vs-supabase.com/compare", "2026-11-02"),
    r("HubSpot Sales Hub pricing", "https://blog.hubspot.com/sales/pricing", "2026-11-03"),
    r("Supabase pricing", "https://supabase.com/pricing", "2026-11-04"),
    r("Ocado prices", "https://www.ocado.co.uk/prices", "2026-11-05"),
  ], 1, "Neon and HubSpot and Ocado pricing");
  const block = (url: string) => rendered.split("\n\n").find((b) => b.includes(url))!;
  expect(block("neon.com/pricing")).toContain("official site");
  expect(block("blog.hubspot.com")).toContain("official site");
  expect(block("ocado.co.uk")).toContain("official site");
  expect(block("neon-vs-supabase.com")).not.toContain("official site");
  expect(block("supabase.com")).not.toContain("official site");
});

it("runs several queries from one call in parallel and numbers the merged results", async () => {
  let inFlight = 0, maxInFlight = 0;
  const provider: SearchProvider & { queries: any[] } = {
    queries: [],
    async search(q) {
      this.queries.push(q); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20)); inFlight--;
      return [r(`${q.query} pricing`, `https://${q.query}.com/pricing`, "2026-11-01")];
    },
    async contents() { return null; },
  };
  const statuses: string[] = [];
  const ctx = newTurnContext((s) => statuses.push(s));
  const out = await searchTool(provider).run({ queries: ["zoho", "pipedrive", "hubspot"], publishedAfter: "2026-11-09" }, ctx);
  expect(maxInFlight).toBe(3);
  expect(provider.queries.map((q) => q.query)).toEqual(["zoho", "pipedrive", "hubspot"]);
  expect(provider.queries.every((q) => q.publishedAfter === "2026-11-09")).toBe(true);
  expect(ctx.searchCalls).toBe(3);
  expect(ctx.sources.map((s) => s.id)).toEqual([1, 2, 3]);
  expect(out.content).toContain("official site");
  expect(statuses).toHaveLength(3);
});

it("runs only as many queries as the cap allows and says which were skipped", async () => {
  const provider = fakeSearch([[r("A", "https://a.com", "2026-11-01")]]);
  const ctx = newTurnContext();
  ctx.searchCalls = 5;
  const out = await searchTool(provider).run({ queries: ["a", "b", "c"] }, ctx);
  expect(provider.queries.map((q: any) => q.query)).toEqual(["a"]);
  expect(out.content).toMatch(/Skipped \(search cap\): b; c/);
});
