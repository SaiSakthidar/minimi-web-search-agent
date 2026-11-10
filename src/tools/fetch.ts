// fetch_url: read one page (HTML, plain text, or PDF) and return only the
// paragraphs that bear on `focus`. Pages that are empty without JavaScript, or
// that refuse the fetch, fall back to the search provider's page contents.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { PDFParse } from "pdf-parse";
import { tokenize } from "../memory/recall.ts";
import type { SearchProvider, SourceRef, ToolHandler } from "./types.ts";

export const FETCH_CAP = 4;
const KEEP = 8;
const OUTPUT_CHARS = 10_000;
const CHUNK_CHARS = 800;
const MIN_PAGE_CHARS = 500;
const MAX_BYTES = 8 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; minimi-agent/0.1)";

export type Para = { heading: string; text: string };
type Page = { title: string; publishedDate: string | null; paras: Para[] };

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form", "iframe", "button", "select"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LEAF_BLOCKS = new Set(["p", "li", "td", "th", "dd", "dt", "pre", "blockquote", "figcaption", "caption"]);
const BLOCKS = new Set([...LEAF_BLOCKS, ...HEADINGS, "div", "section", "article", "main", "ul", "ol", "table", "tbody", "thead", "tr", "dl", "figure", "body"]);

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Split long text into chunks of at most CHUNK_CHARS, on sentence or line boundaries where possible. */
function chunk(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const out: string[] = [];
  let cur = "";
  for (const piece of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (let p = piece; p.length; p = p.slice(CHUNK_CHARS)) {
      const part = p.slice(0, CHUNK_CHARS);
      if (cur && cur.length + part.length + 1 > CHUNK_CHARS) { out.push(cur); cur = ""; }
      cur = cur ? `${cur} ${part}` : part;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Merge short fragments (a price in its own div) into the previous paragraph under the same heading, then bound sizes. */
function normalise(paras: Para[]): Para[] {
  const merged: Para[] = [];
  for (const p of paras) {
    const prev = merged.at(-1);
    if (prev && prev.heading === p.heading && (p.text.length < 80 || prev.text.length < 80) && prev.text.length + p.text.length < CHUNK_CHARS) {
      prev.text = `${prev.text} · ${p.text}`;
    } else merged.push({ ...p });
  }
  const seen = new Set<string>();
  return merged.flatMap((p) => chunk(p.text).map((text) => ({ heading: p.heading, text })))
    .filter((p) => (seen.has(p.text) ? false : (seen.add(p.text), true)));
}

export function textToParagraphs(text: string): Para[] {
  const blocks = text.replace(/^-- \d+ of \d+ --$/gm, "").split(/\n\s*\n/);
  return normalise(blocks.map((b) => ({ heading: "", text: clean(b.replace(/\n/g, ". ").replace(/\.\s*\./g, ".")) })).filter((p) => p.text));
}

function walk(el: any, state: { heading: string; out: Para[] }): void {
  for (const child of el.children ?? []) {
    const tag = String(child.tagName).toLowerCase();
    if (SKIP.has(tag) || child.getAttribute?.("aria-hidden") === "true") continue;
    if (HEADINGS.has(tag)) { state.heading = clean(child.textContent ?? ""); continue; }
    if (tag === "tr") {
      const row = [...child.children].map((c: any) => clean(c.textContent ?? "")).filter(Boolean).join(" | ");
      if (row) state.out.push({ heading: state.heading, text: row });
      continue;
    }
    const hasBlockChild = [...(child.children ?? [])].some((c: any) => BLOCKS.has(String(c.tagName).toLowerCase()));
    if (LEAF_BLOCKS.has(tag) || (BLOCKS.has(tag) && !hasBlockChild)) {
      const text = clean(child.textContent ?? "");
      if (text) state.out.push({ heading: state.heading, text });
      continue;
    }
    walk(child, state);
  }
}

export function extractParagraphs(html: string): Para[] {
  const { document } = parseHTML(html);
  const state = { heading: "", out: [] as Para[] };
  walk(document.body ?? document.documentElement, state);
  return normalise(state.out);
}

function pageMeta(html: string): { title: string; publishedDate: string | null } {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as unknown as Document).parse();
    const title = clean(article?.title || document.querySelector("title")?.textContent || "");
    const t = article?.publishedTime ? new Date(article.publishedTime) : null;
    return { title, publishedDate: t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : null };
  } catch {
    return { title: "", publishedDate: null };
  }
}

export async function pdfToParagraphs(buf: Buffer): Promise<Para[]> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try { return textToParagraphs((await parser.getText()).text); } finally { await parser.destroy(); }
}

export function rankParagraphs(paras: Para[], focus: string, max: number): Para[] {
  const terms = new Set(tokenize(focus));
  const scored = paras.map((p, i) => {
    const words = new Set(tokenize(`${p.heading} ${p.text}`));
    let score = 0;
    for (const t of terms) if (words.has(t)) score++;
    return { p, i, score };
  });
  const matching = scored.filter((s) => s.score > 0);
  const pool = matching.length ? matching : scored; // nothing matches: the start of the page is the best guess
  const top = [...pool].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max);
  return top.sort((a, b) => a.i - b.i).map((s) => s.p);
}

export function fetchTool(provider: SearchProvider, deps: { fetchImpl?: typeof fetch; ttlMs?: number; timeoutMs?: number } = {}): ToolHandler {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ttlMs = deps.ttlMs ?? 15 * 60_000;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const cache = new Map<string, { at: number; page: Page }>();

  async function viaProvider(url: string): Promise<Page | null> {
    try {
      const c = await provider.contents(url);
      if (!c?.text.trim()) return null;
      return { title: "", publishedDate: c.publishedDate ? c.publishedDate.slice(0, 10) : null, paras: textToParagraphs(c.text) };
    } catch { return null; }
  }

  async function load(url: string): Promise<Page | string> {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow", headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5" } });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : (e as Error).message;
      return (await viaProvider(url)) ?? `Could not fetch ${url}: ${why}.`;
    }
    if (!res.ok) return (await viaProvider(url)) ?? `Could not fetch ${url}: HTTP ${res.status}.`;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return `Could not read ${url}: larger than ${MAX_BYTES / 1024 / 1024} MB.`;
    if (type.includes("pdf")) {
      try { return { title: "", publishedDate: null, paras: await pdfToParagraphs(Buffer.from(await res.arrayBuffer())) }; }
      catch (e) { return `Could not read the PDF at ${url}: ${(e as Error).message}.`; }
    }
    if (type && !/html|xml|text\/plain/.test(type)) return `Could not read ${url}: unsupported content type ${type.split(";")[0]}.`;
    const body = await res.text();
    const page: Page = type.includes("text/plain")
      ? { title: "", publishedDate: null, paras: textToParagraphs(body) }
      : { ...pageMeta(body), paras: extractParagraphs(body) };
    const chars = page.paras.reduce((n, p) => n + p.text.length, 0);
    if (chars < MIN_PAGE_CHARS) {
      const fallback = await viaProvider(url);
      if (fallback) return { title: page.title, publishedDate: fallback.publishedDate ?? page.publishedDate, paras: fallback.paras };
    }
    return page;
  }

  return {
    spec: {
      name: "fetch_url",
      description:
        "Read one web page or PDF and return the paragraphs most relevant to `focus`. Use it when search passages are " +
        "not enough, for example a vendor pricing page or changelog. Cite it by the [n] it returns.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL" },
          focus: { type: "string", description: "What you are looking for on the page, e.g. 'Launch plan monthly price'" },
        },
        required: ["url", "focus"],
        additionalProperties: false,
      },
    },
    async run(input, ctx) {
      const { url, focus } = (input ?? {}) as { url?: unknown; focus?: unknown };
      let parsed: URL;
      try { parsed = new URL(String(url)); } catch { return { isError: true, content: `Not a valid URL: ${String(url)}` }; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { isError: true, content: `Only http(s) URLs can be fetched, got ${parsed.protocol}` };
      ctx.fetchCalls++;
      if (ctx.fetchCalls > FETCH_CAP) return { isError: true, content: "Fetch cap reached for this turn. Answer with what you have and say what you could not verify." };
      ctx.onStatus(`reading: ${parsed.hostname}`);

      const key = parsed.href;
      const hit = cache.get(key);
      let page: Page;
      if (hit && Date.now() - hit.at < ttlMs) page = hit.page;
      else {
        const loaded = await load(key);
        if (typeof loaded === "string") return { isError: true, content: loaded };
        page = loaded;
        cache.set(key, { at: Date.now(), page });
      }
      if (page.paras.length === 0) return { isError: true, content: `No readable text at ${key}.` };

      let source = ctx.sources.find((s) => s.url === key);
      if (!source) {
        source = { id: ctx.sources.length + 1, title: page.title || parsed.hostname, url: key, publishedDate: page.publishedDate } satisfies SourceRef;
        ctx.sources.push(source);
      }
      const header = [`[${source.id}] ${source.title}`, `url: ${key}`, `date: ${page.publishedDate ?? "undated"}`].join("\n");
      let out = header;
      for (const p of rankParagraphs(page.paras, String(focus ?? ""), KEEP)) {
        const block = `\n\n## ${p.heading || "(no heading)"}\n${p.text}`;
        if (out.length + block.length > OUTPUT_CHARS) break;
        out += block;
      }
      return { content: out };
    },
  };
}
