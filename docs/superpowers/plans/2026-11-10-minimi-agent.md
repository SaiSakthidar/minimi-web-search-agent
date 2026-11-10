# minimi Chat Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node chat agent with web search that remembers across sessions on disk, re-verifies its own earlier claims against the live web, and streams cited, dated answers to a browser.

**Architecture:** One provider-neutral agent loop (Anthropic primary, Gemini fallback) over two tool halves, `web_search` and `fetch_url`. Memory is a lossless JSONL transcript plus a claim store with validity intervals; the harness recalls by date and topic before every turn and extracts claims after. A plain `http` server streams SSE to a static HTML page.

**Tech Stack:** TypeScript on Node 20, `tsx`, `vitest`, `@anthropic-ai/sdk` 1.7, `@google/genai` 3.0 (Interactions API), `exa-js` 2.28, `chrono-node` 2.10, `pdf-parse` 2.4, `@mozilla/readability` 0.6 + `linkedom` 0.18.

**Spec:** `/home/sksai/Desktop/minimi/llm_design.md`

## Global Constraints

- Node 20 or newer. `npm install` then `npm run dev` must be the whole setup.
- `.env.example` lists every key: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `EXA_API_KEY`, plus the optional `MODEL_PROVIDER`, `ANTHROPIC_MODEL`, `AGENT_NOW`, `PORT`.
- Model ids are exact strings: `claude-opus-5-5`, `claude-haiku-5-5`, `gemini-3.8-flash`. Never date-suffixed.
- No vector DB, embeddings, graph library, MCP, subagents, or framework. Only `http` from the standard library for the server.
- All memory lives under `data/` as JSONL. `data/` is gitignored.
- Message history inside a turn is append-only. Earlier history is never edited.
- Search queries are never cached across turns. `fetch_url` results are cached 15 minutes in-process.
- Per-turn caps: 6 `web_search` calls, 4 `fetch_url` calls, 4 model rounds.
- Every timestamp and "today" comes from `clock.now()`.
- Tests use `vitest`; nothing in tests touches the network or a real API key.

## Review Focus

1. A date in the user message with no recorded messages on that day: the recall block must say "no record for 2026-11-03" so the model can say so, never invent a session. Test in Task 3.
2. Provider changes between turns (Gemini yesterday, Anthropic today): stored `raw` from the other provider must be dropped on replay, never sent. Test in Task 8.
3. A search result without a published date: it must be labelled `undated` and sorted before dated results, never silently treated as fresh. Test in Task 6.
4. `fetch_url` on a URL that times out, returns non-HTML binary, or is not http(s): the tool returns an `is_error` result string and the turn continues. Test in Task 7.
5. The model omits or mangles the diff JSON fence: the prose answer still streams and persists, with no diff event. Test in Task 8.

---

### Task 1: Project scaffold, clock, and memory store

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `README.md` (two lines, filled in Task 12)
- Create: `src/clock.ts`, `src/memory/types.ts`, `src/memory/store.ts`
- Test: `test/clock.test.ts`, `test/memory/store.test.ts`

**Interfaces:**
- Produces `src/clock.ts`:
  ```ts
  export function now(): Date                       // Date.now() unless AGENT_NOW env (ISO) or setOverride() was called
  export function setOverride(iso: string | null): void
  export function dayKey(d: Date | string): string  // "YYYY-MM-DD" in the process's local timezone
  ```
- Produces `src/memory/types.ts`:
  ```ts
  export type SessionMeta = { id: string; startedAt: string; title: string; topics: string[]; seeded: boolean };
  export type StoredMessage = { id: string; sessionId: string; at: string; msg: Msg };   // Msg from Task 4; import type only
  export type Claim = {
    id: string; sessionId: string; turnId: string;
    subject: string; predicate: string; value: string;
    observedAt: string; validFrom: string; validTo: string | null;
    sourceUrl: string; sourceDate: string | null;
  };
  export type ClaimInput = Omit<Claim, "id" | "validFrom" | "validTo">;
  ```
- Produces `src/memory/store.ts`:
  ```ts
  export class MemoryStore {
    static open(dir: string): Promise<MemoryStore>            // creates dir, loads sessions/*.jsonl and claims.jsonl into memory
    listSessions(): SessionMeta[]                             // newest first
    getSession(id: string): SessionMeta | undefined
    createSession(init: { id?: string; startedAt: string; seeded?: boolean }): Promise<SessionMeta>
    updateSession(id: string, patch: Partial<Pick<SessionMeta, "title" | "topics">>): Promise<void>
    appendMessage(sessionId: string, msg: Msg, at: string): Promise<StoredMessage>
    getMessages(sessionId: string): StoredMessage[]
    messagesOnDay(day: string): StoredMessage[]               // by dayKey(at), all sessions, chronological
    addClaim(input: ClaimInput): Promise<Claim>               // applies the contradiction rule
    claims(): Claim[]
  }
  ```

File format: `data/sessions/<id>.jsonl` first line `{"type":"meta",...SessionMeta}`, then one `{"type":"message",...StoredMessage}` per line; `updateSession` rewrites the file. `data/claims.jsonl` is append-only: a closed claim is written again as a full record with `validTo` set, and the loader keeps the last record per `id`. Ids are `crypto.randomUUID()`.

Contradiction rule in `addClaim`: for every existing claim with equal `subject.toLowerCase().trim()` and `predicate.toLowerCase().trim()`, `validTo === null`, and `value !== input.value`, set `validTo = input.observedAt` and rewrite it. Same value: no change, new claim still added.

- [ ] **Step 1: Scaffold the project**

`package.json` scripts: `dev: tsx watch src/server.ts`, `start: tsx src/server.ts`, `test: vitest run`, `seed: tsx scripts/seed.ts`, `eval: tsx eval/run.ts`. `"type": "module"`. Dependencies at the versions in the Tech Stack line; devDependencies `typescript`, `tsx`, `vitest`, `@types/node`. `tsconfig.json`: `"module": "NodeNext"`, `"target": "ES2022"`, `"strict": true`, `"noEmit": true`, `"include": ["src", "scripts", "eval", "test"]`.

Run: `npm install && npx tsc --noEmit`
Expected: no output

- [ ] **Step 2: Write failing clock tests**

```ts
// test/clock.test.ts
it("returns the override when set", () => { setOverride("2026-11-03T10:00:00Z"); expect(now().toISOString()).toBe("2026-11-03T10:00:00.000Z"); setOverride(null); });
it("dayKey uses local date", () => { expect(dayKey("2026-11-03T10:00:00Z")).toMatch(/^2026-11-0[34]$/); });
```

- [ ] **Step 3: Implement `src/clock.ts`; run tests; expect PASS**

- [ ] **Step 4: Write failing store tests**

```ts
// test/memory/store.test.ts  (uses a fresh tmp dir per test via fs.mkdtemp)
it("round-trips a session and messages through disk", async () => {
  const s = await MemoryStore.open(dir);
  const sess = await s.createSession({ startedAt: "2026-11-03T09:00:00Z" });
  await s.appendMessage(sess.id, { role: "user", parts: [{ type: "text", text: "hi" }] }, "2026-11-03T09:00:01Z");
  const s2 = await MemoryStore.open(dir);
  expect(s2.getMessages(sess.id)).toHaveLength(1);
  expect(s2.messagesOnDay(dayKey("2026-11-03T09:00:01Z"))[0].msg.role).toBe("user");
});
it("closes a contradicted claim and keeps the old record", async () => {
  await s.addClaim({ ...base, subject: "Neon Launch", predicate: "price", value: "$19/mo", observedAt: "2026-11-03" });
  await s.addClaim({ ...base, subject: "neon launch ", predicate: "Price", value: "$24/mo", observedAt: "2026-11-10" });
  const [old, fresh] = s.claims();
  expect(old.validTo).toBe("2026-11-10"); expect(fresh.validTo).toBeNull();
  expect((await MemoryStore.open(dir)).claims().find(c => c.id === old.id)!.validTo).toBe("2026-11-10");
});
it("same value does not close the earlier claim", ...)   // both validTo null
it("updateSession persists title and topics", ...)
```

- [ ] **Step 5: Run tests; expect FAIL (module not found)**

- [ ] **Step 6: Implement `src/memory/types.ts` and `src/memory/store.ts`; run tests; expect PASS**

- [ ] **Step 7: Commit** `feat: scaffold, clock, and JSONL memory store`

---

### Task 2: LLM types and a scripted fake provider

**Files:**
- Create: `src/llm/types.ts`, `test/helpers/fakeProvider.ts`

**Interfaces:**
- Produces `src/llm/types.ts`:
  ```ts
  export type TextPart = { type: "text"; text: string };
  export type ToolCallPart = { type: "tool_call"; id: string; name: string; input: unknown };
  export type ToolResultPart = { type: "tool_result"; callId: string; name: string; content: string; isError?: boolean };
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
  export type ProviderName = "anthropic" | "gemini" | "fake";
  export type StreamRequest = { system: string; messages: Msg[]; tools: ToolSpec[]; effort: Effort; signal?: AbortSignal };
  export type JsonRequest = { system: string; prompt: string; schema: Record<string, unknown> };
  export interface LlmProvider {
    readonly name: ProviderName;
    readonly modelLabel: string;                 // shown in the UI header, e.g. "claude-opus-5-5"
    stream(req: StreamRequest): AsyncIterable<LlmEvent>;
    completeJson<T>(req: JsonRequest): Promise<T>;
  }
  ```
- Produces `test/helpers/fakeProvider.ts`:
  ```ts
  export type Scripted = { text?: string; toolCalls?: { name: string; input: unknown }[]; stop?: StopReason; json?: unknown };
  export function fakeProvider(script: Scripted[]): LlmProvider & { calls: StreamRequest[]; jsonCalls: JsonRequest[] }
  ```
  Each `stream` call consumes the next `Scripted`: yields `text` as 3-character deltas, then each tool call with id `call-<n>`, then `done` with `stop` defaulting to `tool_calls` when tool calls exist else `end`, and `raw: { provider: "fake", data: { n } }`. `completeJson` returns the next entry's `json`.

- [ ] **Step 1: Write `src/llm/types.ts` and the fake provider**
- [ ] **Step 2: `npx tsc --noEmit`; expect clean**
- [ ] **Step 3: Commit** `feat: provider-neutral LLM types and test fake`

---

### Task 3: Recall (date resolution, topic match, block assembly)

**Files:**
- Create: `src/memory/recall.ts`
- Test: `test/memory/recall.test.ts`

**Interfaces:**
- Consumes `MemoryStore`, `dayKey`, `Msg`.
- Produces:
  ```ts
  export type ResolvedDate = { phrase: string; day: string };
  export function resolveDates(text: string, now: Date): ResolvedDate[]
  // chrono.parse(text, now, { forwardDate: false }); keep results whose phrase is not purely a time; dedupe by day
  export type RecalledSession = { meta: SessionMeta; day: string; lines: string[]; matchedBy: "date" | "topic" };
  export type RecallResult = { dates: ResolvedDate[]; sessions: RecalledSession[]; claims: Claim[]; missingDays: string[] };
  export function recall(store: MemoryStore, text: string, now: Date, exclude: { sessionId: string }): RecallResult
  export function formatRecall(r: RecallResult, now: Date): string      // the block injected as a system message
  export function tokenize(s: string): string[]                        // lowercase, split on non-alphanumerics, drop < 3 chars and a short stopword list
  ```

Rules pinned by the spec: up to 3 sessions, date-matched first then topic-matched by overlap score (count of shared tokens between the user text and `title + topics + first user message`, ties broken by recency, score 0 excluded). Up to 20 claims by overlap between user text and `subject + predicate`, when zero overlap and a date matched, include all claims whose `observedAt` is on a matched day. Assistant lines trimmed to the first 2,400 characters. Closed claims rendered with `(closed <validTo>)`. A matched day with no messages goes to `missingDays` and renders as `No record for <day>.` The current session is excluded from session matches.

- [ ] **Step 1: Write failing tests**

```ts
it("resolves 'last Tuesday' relative to now", () => {
  const r = resolveDates("Last Tuesday I asked about Postgres", new Date("2026-11-10T12:00:00"));
  expect(r[0].day).toBe("2026-11-03");
});
it("resolves '3 November' to the past occurrence", ...)            // now = 2026-11-10 → 2026-11-03
it("ignores messages without dates", () => expect(resolveDates("what is new in CRMs", now)).toEqual([]));
it("reports a missing day instead of inventing a session", async () => {
  const r = recall(store, "What did I ask you on 3 November?", now, { sessionId: "current" });
  expect(r.sessions).toEqual([]); expect(r.missingDays).toEqual(["2026-11-03"]);
  expect(formatRecall(r, now)).toContain("No record for 2026-11-03");
});
it("matches a session by topic when no date is given", ...)        // session titled "CRM shortlist" with topics ["hubspot","pipedrive"]
it("includes claims observed on a matched day and marks closed ones", ...)  // expect "(closed 2026-11-10)" in the block
it("caps sessions at 3 and claims at 20", ...)
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement `src/memory/recall.ts`; run; expect PASS**
- [ ] **Step 4: Commit** `feat: harness-side recall by date and topic`

---

### Task 4: Anthropic provider

**Files:**
- Create: `src/llm/anthropic.ts`
- Test: `test/llm/anthropic.test.ts` (pure mapping functions only; no client)

**Interfaces:**
- Consumes `LlmProvider`, `Msg`, `ToolSpec`.
- Produces:
  ```ts
  export function toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[]
  export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[]
  export class AnthropicProvider implements LlmProvider {
    constructor(opts: { apiKey: string; chatModel: string; jsonModel: string })   // defaults "claude-opus-5-5", "claude-haiku-5-5"
  }
  ```

Mapping rules:
- `system` Msg → `{ role: "system", content: text }` entry inside `messages` (mid-conversation operator message; native on Anthropic).
- `user` parts → text blocks and `tool_result` blocks (`tool_use_id: callId`, `is_error`).
- `assistant` with `raw.provider === "anthropic"` → `{ role: "assistant", content: raw.data }` verbatim (keeps thinking blocks). Otherwise rebuild from parts: text blocks and `tool_use` blocks (`id`, `name`, `input`).
- Tools: `{ name, description, input_schema, strict: true }` ... `strict` only if the schema has `additionalProperties: false` and `required`; Task 6 schemas do.
- `stream()`: `client.messages.stream({ model, max_tokens: 16000, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], thinking: { type: "adaptive" }, output_config: { effort }, tools, messages })`. Yield `text` on `content_block_delta` with `text_delta`. On `finalMessage()`: yield one `tool_call` per `tool_use` block, then `done` with `stop` mapped from `stop_reason` (`end_turn` → `end`, `tool_use` → `tool_calls`, `max_tokens`, `refusal`; `pause_turn` is treated as `tool_calls` with zero calls, and the loop re-sends) and `raw: { provider: "anthropic", data: final.content }`.
- Refusal fallback: use `client.beta.messages.stream` with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. If the SDK version rejects the field at type level, cast the params; if the API rejects it at runtime, log once and retry without.
- `completeJson`: `client.messages.parse` is not used (schema is JSON, not Zod); call `client.messages.create({ model: jsonModel, max_tokens: 4000, system, messages: [{ role: "user", content: prompt }], output_config: { format: { type: "json_schema", schema } } })` and `JSON.parse` the text block. Check `stop_reason` first; throw on `refusal`/`max_tokens`.

- [ ] **Step 1: Write failing mapping tests**

```ts
it("replays anthropic raw content verbatim", () => {
  const out = toAnthropicMessages([{ role: "assistant", parts: [{ type: "text", text: "x" }], raw: { provider: "anthropic", data: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "x" }] } }]);
  expect(out[0].content).toHaveLength(2);
});
it("rebuilds from parts when raw is from another provider", () => { ... raw: { provider: "gemini", ... } → content has 1 text block });
it("maps tool results to tool_result blocks with tool_use_id", ...)
it("maps system Msg to a system-role message entry", ...)
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement `src/llm/anthropic.ts`; run; expect PASS; `npx tsc --noEmit` clean**
- [ ] **Step 4: Commit** `feat: Anthropic provider`

---

### Task 5: Gemini provider

**Files:**
- Create: `src/llm/gemini.ts`
- Test: `test/llm/gemini.test.ts` (pure mapping only)

**Interfaces:**
- Produces:
  ```ts
  export function toGeminiSteps(messages: Msg[]): Step[]          // Step from @google/genai Interactions
  export function toGeminiTools(tools: ToolSpec[]): FunctionT[]   // { type: "function", name, description, parameters }
  export class GeminiProvider implements LlmProvider {
    constructor(opts: { apiKey: string; model: string })           // default "gemini-3.8-flash"
  }
  ```

Uses the Interactions API (`ai.interactions.create`) in stateless mode. Mapping rules:
- `system` Msg → a `user_input` step whose text is `[Operator note]\n<text>` (Gemini has no mid-conversation system role).
- `user` text → `{ type: "user_input", content: [{ type: "text", text }] }`; `tool_result` → `{ type: "function_result", call_id, name, result: content, is_error }`.
- `assistant` with `raw.provider === "gemini"` → `raw.data` (the array of steps the model produced, including `thought` steps with signatures) spliced in verbatim. Otherwise rebuild: `model_output` with text content plus one `function_call` step per tool call.
- `stream()`: `ai.interactions.create({ model, input: steps, system_instruction: system, tools, store: false, stream: true, generation_config: { thinking_level: effort === "low" ? "low" : effort === "high" ? "high" : "medium" } })`. Iterate events: `step.delta` with `delta.type === "text"` → yield `text`; `step.delta` with `arguments_delta` → accumulate per `index`; `step.start`/`step.stop` → collect the step (function_call steps from `step.stop` or the completed interaction); `interaction.completed` → build `raw.data` from the interaction's `steps` that follow the input, yield one `tool_call` per `function_call` step, then `done` (stop `tool_calls` when any function_call, else `end`; `max_tokens`/`refusal` from the interaction status where present).
- `completeJson`: non-streaming `ai.interactions.create({ model, input: prompt, system_instruction: system, store: false, response_format: { type: "text", mime_type: "application/json", schema } })` and `JSON.parse(interaction.output_text)`.
- Read the exact field names from `node_modules/@google/genai/dist/genai.d.ts` (`Step`, `FunctionCallStep`, `FunctionResultStep`, `UserInputStep`, `ModelOutputStep`, `ThoughtStep`, `StepDelta`, `TextDelta`, `ArgumentsDelta`, `InteractionCompletedEvent`); these are the ones the scratch probe confirmed exist.

- [ ] **Step 1: Write failing mapping tests** (system note wrapping, tool results → `function_result` with `call_id`, gemini raw spliced verbatim, non-gemini raw rebuilt)
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement; run; expect PASS; `npx tsc --noEmit` clean**
- [ ] **Step 4: Commit** `feat: Gemini provider over the Interactions API`

---

### Task 6: Search tool

**Files:**
- Create: `src/tools/types.ts`, `src/tools/exa.ts`, `src/tools/search.ts`
- Test: `test/tools/search.test.ts` (fake `SearchProvider`)

**Interfaces:**
- Produces `src/tools/types.ts`:
  ```ts
  export type RawResult = { title: string | null; url: string; publishedDate?: string; highlights: string[] };
  export interface SearchProvider {
    search(q: { query: string; numResults: number; publishedAfter?: string }): Promise<RawResult[]>;
    contents(url: string): Promise<{ text: string; publishedDate?: string } | null>;
  }
  export type SourceRef = { id: number; title: string; url: string; publishedDate: string | null };
  export type TurnContext = { searchCalls: number; fetchCalls: number; sources: SourceRef[]; onStatus(text: string): void };
  export type ToolHandler = { spec: ToolSpec; run(input: unknown, ctx: TurnContext): Promise<{ content: string; isError?: boolean }> };
  ```
- Produces `src/tools/exa.ts`: `export class ExaProvider implements SearchProvider { constructor(apiKey: string) }` using `exa.searchAndContents(query, { type: "auto", numResults, startPublishedDate: publishedAfter, highlights: { maxCharacters: 1200 } })` and `exa.getContents(url, { text: { maxCharacters: 40000 } })`.
- Produces `src/tools/search.ts`:
  ```ts
  export const SEARCH_CAP = 6;
  export function searchTool(provider: SearchProvider): ToolHandler     // spec.name "web_search"
  export function prepareResults(raw: RawResult[], startId: number): { sources: SourceRef[]; rendered: string }
  ```
  Input schema: `{ type: "object", properties: { query: {type:"string"}, publishedAfter: {type:"string", description:"YYYY-MM-DD; only results published after this"}, numResults: {type:"integer", minimum:3, maximum:10} }, required: ["query"], additionalProperties: false }`. Default `numResults` 8.

`prepareResults` rules: drop results whose `tokenize(title)` set equals an earlier result's (syndicated copies); sort undated first then ascending `publishedDate`; assign ids from `startId`; trim to 3 highlights of ≤ 400 chars each; render each as
```
[<id>] <title>
url: <url>
date: <YYYY-MM-DD | undated>
- <highlight>
```
`run`: increment `ctx.searchCalls`; when it exceeds `SEARCH_CAP`, return `{ isError: true, content: "Search cap reached for this turn. Answer with what you have and say what you could not verify." }`. Call `ctx.onStatus("searching: <query>" + (publishedAfter ? " since <date>" : ""))`. Push sources into `ctx.sources`, ids continuing from `ctx.sources.length + 1`.

- [ ] **Step 1: Write failing tests**

```ts
it("labels undated results and sorts them first, then oldest to newest", ...)
it("collapses syndicated duplicates by title", ...)        // two results, same title, different domains → one
it("numbers sources continuing from the turn context", ...) // second call starts at id 4 after a 3-result first call
it("returns an error result past the cap", async () => { ctx.searchCalls = 6; expect((await tool.run({ query: "x" }, ctx)).isError).toBe(true); });
it("passes publishedAfter through to the provider", ...)
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement the three files; run; expect PASS**
- [ ] **Step 4: Commit** `feat: web_search tool with dated, deduped passages`

---

### Task 7: Fetch tool

**Files:**
- Create: `src/tools/fetch.ts`
- Test: `test/tools/fetch.test.ts` (local `http.createServer` fixture serving HTML, a PDF, and a hanging route)

**Interfaces:**
- Produces:
  ```ts
  export const FETCH_CAP = 4;
  export function fetchTool(provider: SearchProvider, deps?: { fetchImpl?: typeof fetch; ttlMs?: number }): ToolHandler   // spec.name "fetch_url"
  export function extractParagraphs(html: string): { heading: string; text: string }[]    // Readability via linkedom; fall back to <p>/<li>/<h*> walk
  export function rankParagraphs(paras: { heading: string; text: string }[], focus: string, max: number): { heading: string; text: string }[]
  export function pdfToParagraphs(buf: Buffer): Promise<{ heading: string; text: string }[]>   // pdf-parse; split on blank lines
  ```
  Input schema: `{ url: string, focus: string }`, both required, `additionalProperties: false`.

`run` rules: reject non-http(s) URLs with an error result; `fetchCalls` cap like Task 6 ("Fetch cap reached..."); 10 s timeout via `AbortSignal.timeout`; `content-type` containing `pdf` → `pdfToParagraphs`; HTML → `extractParagraphs`; when the extracted text is under 500 characters, call `provider.contents(url)` and split that text on blank lines instead; rank by shared `tokenize` terms with `focus`, keep 8, cap the rendered output at 10,000 characters; render as `## <heading>\n<text>` blocks preceded by `url: ...` and `date: ...` when the provider fallback supplied one. Cache the rendered string by URL for `ttlMs` (default 15 min). Status: `ctx.onStatus("reading: <hostname>")`.

- [ ] **Step 1: Write failing tests**

```ts
it("returns the paragraphs most related to focus from HTML", ...)   // fixture page with a pricing table and unrelated nav text; expect pricing paragraph present, nav absent
it("extracts text from a PDF", ...)                                 // small generated PDF fixture in test/fixtures
it("errors on non-http URLs without throwing", ...)
it("errors on timeout without throwing", ...)                       // hanging route, ttl/timeout injected small
it("falls back to provider.contents when the page is near-empty", ...)
it("serves the second fetch of the same URL from cache", ...)       // fetchImpl call count stays 1
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement; run; expect PASS**
- [ ] **Step 4: Commit** `feat: fetch_url tool for HTML and PDF with provider fallback`

---

### Task 8: Prompt policy and the agent loop

**Files:**
- Create: `src/agent/prompt.ts`, `src/agent/loop.ts`
- Test: `test/agent/loop.test.ts` (fake provider from Task 2, stub tools)

**Interfaces:**
- Produces `src/agent/prompt.ts`:
  ```ts
  export const DIFF_FENCE = "```json-diff";            // the model ends "what changed" answers with this fence
  export type DiffItem = { item: string; before: string | null; beforeDate: string | null; after: string | null; afterDate: string | null; verdict: "changed" | "same" | "unverified"; source: number | null };
  export function systemPrompt(opts: { today: string; providerLabel: string }): string
  export function lastRoundNote(): string              // "No more tool calls available. Answer now with what you have, and say what you could not verify."
  export function pickEffort(userText: string): Effort // "low" for ≤ 12 tokens with no date and no comparison words, else "medium"
  ```
  The system prompt text is the builder's, but it must state: today's date; the one-search-per-fact / parallel-for-comparisons / `publishedAfter` for "since" questions policy; start broad then narrow; prefer primary sources; premise check against the recall block; every world fact carries `[n]` matching a result id from this turn; never say "as of my training data"; for "what changed" answers end with a `json-diff` fenced block containing `{ "items": DiffItem[] }`; be direct and match the length of the question. Keep the date on its own final line so the cached prefix above it is stable.
- Produces `src/agent/loop.ts`:
  ```ts
  export const MAX_ROUNDS = 4;
  export type TurnEvent =
    | { type: "text"; delta: string }
    | { type: "status"; text: string }
    | { type: "diff"; items: DiffItem[] }
    | { type: "notice"; text: string };                  // max_tokens / refusal copy
  export type TurnResult = { newMessages: Msg[]; text: string; diff: DiffItem[] | null; sources: SourceRef[]; rounds: number };
  export function runTurn(opts: {
    provider: LlmProvider; system: string; history: Msg[]; tools: ToolHandler[];
    effort: Effort; onEvent: (e: TurnEvent) => void; signal?: AbortSignal;
  }): Promise<TurnResult>
  export function splitDiff(text: string): { prose: string; diff: DiffItem[] | null }   // strips the fence; null on missing or invalid JSON
  ```

Loop rules: `history` is sent as given (the server has already appended the recall system message and the user message). Each round: stream; buffer text, and once the buffer contains `DIFF_FENCE` stop emitting `text` events for anything from the fence onward. On `done`: push the assistant Msg (parts from accumulated text and tool calls, `raw` from the event). `stop === "tool_calls"` with calls: run all handlers with `Promise.all`, emitting `status` from `ctx.onStatus`; unknown tool name → error result; push one user Msg with all `tool_result` parts; continue. Before round `MAX_ROUNDS`, push `{ role: "system", text: lastRoundNote() }` and run that round with `tools: []`. `max_tokens` → `notice` "The answer was cut short." and stop. `refusal` → `notice` "The model declined to answer this." and stop. Replay guard: before calling the provider, map history so any assistant `raw` whose `provider !== provider.name` is removed. Final text is `splitDiff(buffer).prose`.

- [ ] **Step 1: Write failing tests**

```ts
it("runs parallel tool calls and feeds all results in one user message", ...)   // script: 2 tool calls then text; expect newMessages[1].parts.length === 2
it("stops after MAX_ROUNDS with the last-round note and no tools", ...)         // script of 5 tool-call rounds; expect provider.calls[3].tools = [] and calls[3].messages.at(-1).role === "system" ... (note precedes the final round)
it("strips raw from another provider before sending", ...)                       // history has raw.provider "gemini", provider.name "fake"; expect provider.calls[0].messages assistant has no raw
it("splits a well-formed diff fence into a diff event and keeps prose", ...)
it("streams the whole prose when the fence is missing or malformed", ...)        // Review Focus 5
it("emits a notice and stops on max_tokens", ...)
it("returns an error tool_result for an unknown tool", ...)
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement `prompt.ts` and `loop.ts`; run; expect PASS**
- [ ] **Step 4: Commit** `feat: provider-neutral agent loop and prompt policy`

---

### Task 9: Claim extraction

**Files:**
- Create: `src/memory/extract.ts`
- Test: `test/memory/extract.test.ts` (fake provider `json` entries)

**Interfaces:**
- Produces:
  ```ts
  export const EXTRACT_SCHEMA: Record<string, unknown>   // { title?: string, topics: string[], claims: { subject, predicate, value, source: integer }[] }
  export type ExtractInput = { sessionId: string; turnId: string; userText: string; assistantText: string; sources: SourceRef[]; observedAt: string; isFirstTurn: boolean };
  export function extractTurn(provider: LlmProvider, input: ExtractInput): Promise<{ title?: string; topics: string[]; claims: ClaimInput[] }>
  export function scheduleExtraction(provider: LlmProvider, store: MemoryStore, input: ExtractInput, log: (e: unknown) => void): void   // fire-and-forget; applies title/topics and addClaim
  ```
  Rules: `claims` whose `source` is not an id in `input.sources` are dropped; kept claims get `sourceUrl`/`sourceDate` from that source and `observedAt = dayKey(input.observedAt)`. Title only applied when `isFirstTurn`. Errors are passed to `log` and swallowed.

- [ ] **Step 1: Write failing tests** (uncited claim dropped; cited claim carries source url/date; title only on first turn; provider error does not reject `scheduleExtraction`)
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement; run; expect PASS**
- [ ] **Step 4: Commit** `feat: background claim extraction`

---

### Task 10: Provider selection, server, and SSE API

**Files:**
- Create: `src/llm/select.ts`, `src/server.ts`
- Test: `test/server.test.ts` (start server on port 0 with fake provider and fake search provider injected; drive with `fetch`)

**Interfaces:**
- Produces `src/llm/select.ts`:
  ```ts
  export function selectProvider(env: NodeJS.ProcessEnv): LlmProvider    // MODEL_PROVIDER wins; else ANTHROPIC_API_KEY, else GEMINI_API_KEY; else throw with a message naming .env.example
  ```
- Produces `src/server.ts`:
  ```ts
  export function createApp(deps: { provider: LlmProvider; search: SearchProvider; store: MemoryStore }): http.Server
  // when run directly: loads .env (hand-rolled 15-line parser, no dotenv), selects provider, opens data/, listens on PORT || 3000
  ```
  Routes:
  - `GET /` and `GET /app.js`, `GET /app.css` → files from `public/`.
  - `GET /api/meta` → `{ today: dayKey(now()), nowIso, provider: name, model: modelLabel }`.
  - `GET /api/sessions` → `SessionMeta[]`; `POST /api/sessions` → new session (`startedAt: now()`); `GET /api/sessions/:id/messages` → `StoredMessage[]` with `raw` stripped.
  - `POST /api/sessions/:id/turn` body `{ text }` → SSE. Server steps per the spec's section 4: `now()`, `recall(...)`, append the recall system Msg and the user Msg to the stored transcript (so replay is append-only), build `history` from `getMessages`, `runTurn`, forward `TurnEvent`s as SSE events `text`, `status`, `diff`, `notice`; send `recall` (the formatted block) before the first text and `sources` after `runTurn`; persist each new Msg with `at = now()`; `scheduleExtraction`; send `done`.
  - `POST /api/clock` body `{ now: string | null }` → `setOverride`. Dev convenience, documented as such.
  - Unknown → 404 JSON. Errors → SSE `error` event then end.

- [ ] **Step 1: Write failing tests**

```ts
it("GET /api/meta reports provider and today", ...)
it("a turn streams text and done, and persists user + assistant messages", ...)   // fake provider script [{ text: "Hello [1]" }]
it("a turn with a date and no record sends a recall event containing 'No record for'", ...)
it("POST /api/clock changes today in /api/meta", ...)
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement `select.ts` and `server.ts`; run; expect PASS**
- [ ] **Step 4: Commit** `feat: http server with SSE turns and session API`

---

### Task 11: Browser UI

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/app.css`

No automated test; verified by hand against the spec's section 4.9 with the fake-free dev server.

Layout B from the design: sidebar with sessions (date, title, `seeded` tag, "New conversation"); header with "today is <day>" and the model label from `/api/meta`; chat column. Per assistant turn render in this order: sources row (cards: domain, title, date or "undated", linking to the URL), diff table when a `diff` event arrives (columns Item, Before, Today, Verdict with the `[n]` marker), streamed prose with `[n]` markers turned into links to the matching source card. A collapsed "recalled …" chip above the answer when a `recall` event arrives (click to expand the block). A status line that shows the latest `status` event while the turn runs. `notice` renders as a muted line. Markdown: bold, inline code, bullet lists, paragraphs only, via a 40-line renderer; no library. Dark/light follow `prefers-color-scheme`. Phone width works.

- [ ] **Step 1: Write the three files**
- [ ] **Step 2: Run `npm run dev` with a real key, open the page, run the three questions from the brief, confirm sources row, diff table, recall chip, status line**
- [ ] **Step 3: Commit** `feat: research-style chat UI`

---

### Task 12: Seed script, eval, README, .env.example

**Files:**
- Create: `scripts/seed.ts`, `eval/questions.json`, `eval/run.ts`
- Modify: `README.md`, `.env.example`

**Interfaces:**
- `scripts/seed.ts`: with the real provider and search provider, for each of three scripted sessions (`CRM shortlist for a 20-person sales team` on the most recent Monday, `Managed Postgres hosting` on the most recent Tuesday, `Unrelated: best laptop for travel` on 3 November), `setOverride(<that day 10:00 local>)`, create a session with `seeded: true`, run the scripted user turns through the same code path the server uses (factor the per-turn routine out of `server.ts` into `src/agent/turn.ts` as `export async function handleTurn(deps, sessionId, text, onEvent)` and call it from both), wait for extraction to finish (expose `awaitExtractions()` from `extract.ts`), then clear the override. Refuses to run if `data/` already has seeded sessions unless `--force`.
- `eval/questions.json`: 20 entries `{ id, text, needsSearch: boolean, expects: string[] }`, including the three from the brief and at least five that must not search (greetings, arithmetic, "what did we just discuss").
- `eval/run.ts`: runs each question in a fresh session via `handleTurn`, records rounds, search calls, elapsed ms, whether a diff was produced, and asks the provider's `completeJson` to grade `{ correct: boolean, cited: boolean, notes }` against `expects`. Prints a table and writes `eval/results-<provider>-<timestamp>.json`.

- [ ] **Step 1: Refactor `handleTurn` out of `server.ts`; run the Task 10 tests; expect PASS**
- [ ] **Step 2: Write `scripts/seed.ts`; run `npm run seed`; confirm three sessions and some claims in `data/`**
- [ ] **Step 3: Write `eval/questions.json` and `eval/run.ts`; run `npm run eval` once; keep the output file**
- [ ] **Step 4: Write `README.md`** (setup in five lines, keys and where to get them with the free-tier note, `npm run seed`, `AGENT_NOW`, `MODEL_PROVIDER`, what `data/` holds) **and finalise `.env.example`** with one comment per key
- [ ] **Step 5: `npm test` and `npx tsc --noEmit` clean; commit** `feat: seed script, eval harness, README`

---

## Self-review notes

- Spec coverage: 4.1 Task 1; 4.2 Task 3; 4.3 Task 9; 4.4 Tasks 6 and 7; 4.5 Tasks 2, 4, 5, 8; 4.6 Task 8; 4.7 Task 1 and 10; 4.8 Task 12; 4.9 Task 11; 4.10 layout matches file lists; section 5a eval on both providers via `MODEL_PROVIDER` in Task 12.
- Names used across tasks: `Msg`, `LlmProvider`, `ToolHandler`, `TurnContext`, `SourceRef`, `MemoryStore`, `recall`/`formatRecall`, `runTurn`, `extractTurn`/`scheduleExtraction`, `handleTurn`, `dayKey`, `now`/`setOverride`, `DIFF_FENCE`, `DiffItem`. Checked for consistency.
- Review Focus items 1 to 5 each have a named test in Tasks 3, 8, 6, 7, 8.
