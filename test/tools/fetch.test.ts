import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { extractParagraphs, fetchTool, pdfToParagraphs, rankParagraphs } from "../../src/tools/fetch.ts";
import { newTurnContext, type SearchProvider } from "../../src/tools/types.ts";
import { makePdf } from "../helpers/pdf.ts";

const filler = "Our platform helps teams ship faster with branching databases and instant restore. ".repeat(8);
const PRICING_HTML = `<!doctype html><html><head><title>Neon Pricing</title></head><body>
<nav><ul><li>Home</li><li>Docs</li><li>Careers</li><li>Login</li></ul></nav>
<main><h1>Plans</h1><p>${filler}</p>
<h2>Launch</h2><p>The Launch plan costs $24 per month and includes 10 GB of storage.</p>
<h2>Scale</h2><p>The Scale plan costs $69 per month with autoscaling compute.</p>
<h2>Company</h2><p>We were founded by database people who love open source and community.</p></main>
<footer>Copyright Neon</footer></body></html>`;

let server: Server;
let base: string;
let hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    hits[req.url!] = (hits[req.url!] ?? 0) + 1;
    if (req.url === "/pricing") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PRICING_HTML); }
    else if (req.url === "/doc.pdf") { res.setHeader("content-type", "application/pdf"); res.end(makePdf(["Price list", "", "Pro plan costs $25 per month"])); }
    else if (req.url === "/empty") { res.setHeader("content-type", "text/html"); res.end("<html><body><div id=app></div></body></html>"); }
    else if (req.url === "/image.png") { res.setHeader("content-type", "image/png"); res.end(Buffer.from([137, 80, 78, 71])); }
    else if (req.url === "/forbidden") { res.statusCode = 403; res.end("no bots"); }
    else if (req.url === "/hang") { /* never responds */ }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const noContents: SearchProvider = { async search() { return []; }, async contents() { return null; } };
const local = { allowPrivateHosts: true }; // the fixture server is on 127.0.0.1

it("returns the paragraphs most related to focus from HTML", async () => {
  const ctx = newTurnContext();
  const out = await fetchTool(noContents, local).run({ url: `${base}/pricing`, focus: "Launch plan price per month" }, ctx);
  expect(out.isError).toBeFalsy();
  expect(out.content).toContain("The Launch plan costs $24 per month");
  expect(out.content).toContain("## Launch");
  expect(out.content).not.toContain("Careers");
  expect(out.content).not.toContain("founded by database people");
});

it("registers the fetched page as a numbered source", async () => {
  const ctx = newTurnContext();
  ctx.sources.push({ id: 1, title: "x", url: "https://x.com", publishedDate: null });
  const out = await fetchTool(noContents, local).run({ url: `${base}/pricing`, focus: "launch price" }, ctx);
  expect(ctx.sources[1]).toMatchObject({ id: 2, url: `${base}/pricing`, title: "Neon Pricing" });
  expect(out.content).toContain("[2]");
});

it("extracts text from a PDF", async () => {
  const out = await fetchTool(noContents, local).run({ url: `${base}/doc.pdf`, focus: "pro plan price" }, newTurnContext());
  expect(out.content).toContain("Pro plan costs $25 per month");
});

it("errors on non-http URLs without throwing", async () => {
  const out = await fetchTool(noContents, local).run({ url: "file:///etc/passwd", focus: "x" }, newTurnContext());
  expect(out.isError).toBe(true);
});

it("errors on unsupported binary content types", async () => {
  const out = await fetchTool(noContents, local).run({ url: `${base}/image.png`, focus: "x" }, newTurnContext());
  expect(out.isError).toBe(true);
  expect(out.content).toMatch(/image\/png/);
});

it("errors on timeout without throwing", async () => {
  const out = await fetchTool(noContents, { ...local, timeoutMs: 200 }).run({ url: `${base}/hang`, focus: "x" }, newTurnContext());
  expect(out.isError).toBe(true);
});

it("falls back to provider.contents when the page is near-empty", async () => {
  const provider: SearchProvider = {
    async search() { return []; },
    async contents() { return { text: "Rendered by JS.\n\nThe Team plan costs $599 per month.", publishedDate: "2026-11-07T00:00:00Z" }; },
  };
  const out = await fetchTool(provider, local).run({ url: `${base}/empty`, focus: "team plan price" }, newTurnContext());
  expect(out.content).toContain("The Team plan costs $599 per month.");
  expect(out.content).toContain("date: 2026-11-07");
});

it("falls back to provider.contents when the site refuses the fetch", async () => {
  const provider: SearchProvider = { async search() { return []; }, async contents() { return { text: "Enterprise is custom priced." }; } };
  const out = await fetchTool(provider, local).run({ url: `${base}/forbidden`, focus: "enterprise price" }, newTurnContext());
  expect(out.content).toContain("Enterprise is custom priced.");
});

it("serves the second fetch of the same URL from cache", async () => {
  hits = {};
  const tool = fetchTool(noContents, local);
  await tool.run({ url: `${base}/pricing`, focus: "launch" }, newTurnContext());
  const second = await tool.run({ url: `${base}/pricing`, focus: "scale plan" }, newTurnContext());
  expect(hits["/pricing"]).toBe(1);
  expect(second.content).toContain("The Scale plan costs $69");
});

it("returns an error result past the cap", async () => {
  const ctx = newTurnContext();
  ctx.fetchCalls = 4;
  const out = await fetchTool(noContents, local).run({ url: `${base}/pricing`, focus: "x" }, ctx);
  expect(out).toMatchObject({ isError: true });
  expect(out.content).toContain("Fetch cap reached");
});

it("extractParagraphs keeps headings with their text and skips nav", () => {
  const paras = extractParagraphs(PRICING_HTML);
  expect(paras).toContainEqual({ heading: "Launch", text: "The Launch plan costs $24 per month and includes 10 GB of storage." });
  expect(paras.some((p) => p.text.includes("Careers"))).toBe(false);
});

it("rankParagraphs keeps document order among the top matches", () => {
  const paras = [{ heading: "", text: "alpha beta" }, { heading: "", text: "nothing here" }, { heading: "", text: "beta gamma alpha" }];
  expect(rankParagraphs(paras, "alpha beta gamma", 2).map((p) => p.text)).toEqual(["alpha beta", "beta gamma alpha"]);
});

it("pdfToParagraphs chunks long pages into bounded paragraphs", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `Line ${i} of a long price sheet with many rows of plans`);
  const paras = await pdfToParagraphs(makePdf(lines));
  expect(paras.length).toBeGreaterThan(2);
  for (const p of paras) expect(p.text.length).toBeLessThanOrEqual(900);
});

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

it("refuses loopback, private and link-local hosts by default", async () => {
  const tool = fetchTool(noContents);
  for (const url of [`${base}/pricing`, "http://localhost:9/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/"]) {
    const out = await tool.run({ url, focus: "x" }, newTurnContext());
    expect(out.isError, url).toBe(true);
    expect(out.content, url).toMatch(/private|local/i);
  }
  const viaDns = fetchTool(noContents, { lookup: async () => [{ address: "10.0.0.5", family: 4 }] });
  expect((await viaDns.run({ url: "http://intranet.example/", focus: "x" }, newTurnContext())).isError).toBe(true);
});

it("re-checks every redirect hop", async () => {
  const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } })) as typeof fetch;
  const out = await fetchTool(noContents, { fetchImpl, lookup: publicDns }).run({ url: "https://vendor.example/pricing", focus: "x" }, newTurnContext());
  expect(out.isError).toBe(true);
  expect(out.content).toMatch(/private|local/i);
});

it("stops reading a body larger than the byte cap even without content-length", async () => {
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 50; i++) c.enqueue(new TextEncoder().encode("<p>" + "x".repeat(1000) + "</p>")); c.close(); } });
  const fetchImpl = (async () => new Response(big, { headers: { "content-type": "text/html" } })) as typeof fetch;
  const out = await fetchTool(noContents, { fetchImpl, lookup: publicDns, maxBytes: 10_000 }).run({ url: "https://vendor.example/", focus: "x" }, newTurnContext());
  expect(out.isError).toBe(true);
  expect(out.content).toMatch(/larger than/);
});
