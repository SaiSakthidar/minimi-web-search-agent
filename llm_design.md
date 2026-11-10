# minimi chat agent: design

Date: 2026-11-10. Status: draft for build. The final `DESIGN.md` is written by hand from this.

## 1. Intent

A chat agent on Node with one capability, web search, that answers fast, gets facts right, cites dated sources, and remembers across sessions and restarts. The hidden test is not search, it is **memory plus freshness**: "what did I ask on 3 November, is that answer still correct today" means recall a dated claim, re-check it on the web, report the diff.

Judged on architecture, correctness, speed, conversational quality, and the clarity of the code and design. Features beyond that lose.

## 2. Goals, non-goals, anti-goals

Goals
- Answer current-events and pricing questions with cited, dated sources.
- Recall earlier sessions by date ("last Tuesday", "on Monday", "3 November") and by topic.
- Treat its own earlier answers as claims to re-verify, and say explicitly what changed, what didn't, and what it couldn't confirm.
- First token in under 2 seconds for a no-search turn, under 5 seconds for a search turn, full answer typically under 20 seconds.
- Survive restart: all memory on disk.
- `npm install && npm run dev` is the whole setup. Keys listed in `.env.example`.

Non-goals
- Multi-user auth, deployment, rate limiting.
- Vector database, embeddings, knowledge graph, MCP, multi-agent orchestration, model fine-tuning.
- Reading PDFs, images, or JavaScript-rendered pages.

Anti-goals (would make this a failure even if it works)
- Answering a "has it changed" question from memory alone without searching.
- Asserting a price or date with no citation.
- Hedging with "as of my training cutoff". The agent has search; it must use it or say it couldn't find out.
- Silent caching that serves Tuesday's result to a "what is it today" question.

## 3. Constraints

- TypeScript on Node 20 or newer (the machine has 20.19), no web framework beyond the standard library's `http` (or a tiny one if the builder prefers). `tsx` for `npm run dev`.
- Model: two providers behind one `LlmProvider` interface, chosen at startup from the environment. **Anthropic** is the primary: `claude-opus-5-5` for chat (adaptive thinking, streaming, effort `medium`), `claude-haiku-5-5` for the offline claim-extraction pass. `ANTHROPIC_MODEL` overrides the chat model; Sonnet 5.5 is the cheaper, slightly faster alternative, Opus is the default because the brief values correctness and judgment over cost. **Gemini** is the fallback and the day-to-day test target, because the author has no Anthropic key during development: `gemini-3.8-flash` for both chat and extraction (it has a free tier; `gemini-4-argon` does not). `MODEL_PROVIDER=anthropic|gemini` selects; if unset, the first provider whose key is present wins, Anthropic first.
- Search provider: Exa (`exa-js`). Chosen because one call returns query-matched passages ("highlights") per result, a published date, and a `startPublishedDate` filter. Provider sits behind a `SearchProvider` interface; swapping for Tavily or Brave is one file.
- Memory on disk as JSON Lines under `data/`. No database.
- Append-only message history inside a turn (required by the model's preserved-thinking check).

## 4. How it works

```
browser ──SSE──▶ server.ts ──▶ turn()                           
                                 │ 1. clock.now()  (env override for demos)
                                 │ 2. memory.recall(userMsg, now)  ← harness, not the model
                                 │ 3. agent.run(messages, recallBlock, tools)
                                 │      loop: Claude ⇄ web_search / fetch_url (parallel, capped)
                                 │      stream text + citations to browser
                                 │ 4. memory.append(transcript)       (sync, before responding done)
                                 │ 5. memory.extractClaims(turn)      (async, off the response path)
```

### 4.1 Memory: two layers on disk

**Transcript log** `data/sessions/<session-id>.jsonl`. Lossless. One line per message with `role`, `content`, `at` (ISO timestamp from the clock). Session metadata line at top: `id`, `startedAt`, `title`, `topics[]` (filled by extraction). A session is one browser conversation; a new conversation is a new session.

**Claim store** `data/claims.jsonl`. Facts the agent stated, with validity intervals (the Zep/Graphiti idea without the graph):

```
{ id, sessionId, turnId,
  subject: "HubSpot Starter",          // normalised entity string
  predicate: "price",                   // free text, short
  value: "$20 per seat per month",
  observedAt: "2026-11-03",             // when the agent learned it
  validFrom: "2026-11-03", validTo: null,   // closed when a later claim contradicts
  sourceUrl, sourceDate }
```

Rules:
- A claim is written only when the answer cited a source for it. Uncited statements are not claims.
- When a new claim arrives with the same `subject` + `predicate` and a different `value`, set the old claim's `validTo` to the new `observedAt`. Never delete.
- Indexes are built in memory at startup from the JSONL files (by subject, by session date, by observedAt). Files are small; no index persistence needed.

### 4.2 Recall: done by the harness before every turn

The model never calls a memory tool. The harness builds a recall block and injects it as a mid-conversation system message (keeps the cached prefix stable).

1. **Date resolution.** Parse relative and absolute dates in the user message with `chrono-node` against `clock.now()` ("last Tuesday", "on Monday", "3 November", "yesterday"). Each resolved date selects the messages whose `at` falls on that day, grouped by session. Matching on message timestamps, not session start, means one long conversation used across several days still answers "what did I ask on Monday".
2. **Topic match.** Score every session by keyword overlap between the user message and the session's `title` + `topics` + first user message. Score claims by overlap with `subject` + `predicate`. Simple tokenised overlap; no embeddings.
3. **Assemble.** Up to 3 sessions (date-matched first, then topic-matched), each as: date, title, and the user turns plus a trimmed version of the assistant answers (first ~600 tokens each). Up to 20 claims, each as one line: `[observed 2026-11-03] HubSpot Starter price = $20/seat/mo (source, source date)`. Current claims and closed claims both shown, closed ones marked.
4. If nothing matches, the recall block says so explicitly, so the model can tell the user "I have no record of a conversation on 3 November" rather than invent one.

The current session's own transcript is passed as normal `messages`, not through recall. Earlier recall blocks stay in the transcript and are replayed as-is; a new block is appended each turn. Nothing earlier in the history is ever edited, which keeps the model's preserved-thinking check and the prompt cache both happy.

### 4.3 Extraction: after the answer, off the response path

After the assistant's turn is streamed and persisted, a background job calls the provider's `completeJson` (Haiku 5.5 on Anthropic, Gemini 3.8 Flash on Gemini) with a JSON schema to extract from the turn: a session `title` (first turn only), `topics[]`, and `claims[]` in the schema above. Only claims that map to a citation in the answer are kept. Written to the claim store with the contradiction rule applied. Failure here is logged and never surfaces to the user.

### 4.4 Tools (one capability, two halves)

`web_search({ query, publishedAfter?, numResults? })`
- Calls Exa with `type: "auto"`, highlights on, `numResults` default 8, `startPublishedDate` when given.
- Returns a compact list: `{ id, title, url, publishedDate | "undated", highlights[] }`. Highlights trimmed to ~3 per result, ~400 chars each.
- Results sorted oldest to newest so the freshest sit closest to the model's next step (FreshPrompt finding). Undated results go first and are labelled `undated`.
- Near-duplicate titles across domains collapse to one result (syndicated press releases are one source).
- Per-turn cap: 6 search calls. Beyond the cap the tool returns an error telling the model to answer with what it has.

`fetch_url({ url, focus })`
- Fetches HTML, strips to text (readability-style), splits on headings/paragraphs, returns the ~8 paragraphs with the highest term overlap with `focus`, each prefixed with its heading. Hard cap ~2,500 tokens returned.
- Cached by URL for 15 minutes within the process.
- Per-turn cap: 4 fetches.

Search queries are **not** cached across turns. Freshness questions must hit the network.

### 4.5 Agent loop and the provider seam

The loop is written once against a small internal message model, not against either SDK's types. That is the price of supporting two providers, and it is paid in one place.

```
type Msg =
  | { role: "system";    text }                                   // mid-conversation operator notes (recall block, "answer now")
  | { role: "user";      parts: (Text | ToolResult)[] }
  | { role: "assistant"; parts: (Text | ToolCall)[]; raw?: unknown } // raw = provider-native content, replayed only to the same provider

interface LlmProvider {
  stream(req: { system, messages: Msg[], tools: ToolSpec[], effort }): AsyncIterable<
    | { type: "text", delta }
    | { type: "tool_call", id, name, input }
    | { type: "done", stop: "end" | "tool_calls" | "max_tokens" | "refusal" }>
  completeJson<T>(req: { system, prompt, schema }): Promise<T>   // used by extraction
}
```

`anthropic.ts` maps `Msg` to Messages API blocks, keeps `raw` so thinking blocks go back unchanged on the same provider, enables prompt caching on the system prompt, sets `output_config.effort`, and turns on server-side fallbacks for refusals. `gemini.ts` maps the same `Msg` to `@google/genai` contents with function declarations and thinking enabled. Provider-specific features that the other side lacks (Anthropic's thinking replay, Gemini's thought signatures) live inside that provider's file and never leak into the loop.

The loop itself, around 80 lines:
- Stream text deltas to the browser as they arrive.
- When a round ends with tool calls, run them all concurrently (`Promise.all`), append the assistant message and one user message holding every tool result, and continue.
- Hard cap of 4 model rounds per turn. On the last round the harness appends a one-line system note: "No more tool calls available. Answer now with what you have, and say what you could not verify."
- Branch on `stop` before reading content: `max_tokens` and `refusal` get a short user-visible notice, never a silent empty answer.
- Message history inside a turn is append-only. Across turns the stored transcript is replayed as `messages`; `raw` is dropped when the provider at replay time differs from the one that produced it.

Mid-conversation `system` messages are native on Anthropic. On Gemini they are rendered as a clearly delimited user-role note, since Gemini has no equivalent; the delimiting is done in `gemini.ts`, not in the loop.

### 4.6 System prompt policy (the part that does most of the work)

Stable prefix, cached. The policy, in plain terms:
- Today's date is given (from the clock). Reason about dates from it.
- Effort scaling: a fact or a price is one search. A comparison across N things is N parallel searches. A "has anything changed" question is one search per remembered claim, with `publishedAfter` set to the claim's `observedAt`.
- Start with short broad queries, then narrow. Prefer primary sources (vendor pricing page, official changelog) over aggregators.
- Premise check: if the user's message assumes something the record doesn't support (no session on that date, a tool that wasn't on the list), say so first.
- Every factual claim about the world carries a citation marker `[n]` that maps to a result id from this turn. If something can't be cited, say it's unverified. No "as of my training data".
- "What changed" answers use a fixed shape: for each item, previous value and date, current value and date, verdict (changed / unchanged / couldn't confirm), source.
- Conversational register: direct, short, no preamble, no bullet soup for simple questions. Match the length of the question.

### 4.7 Clock

`clock.now()` returns `Date.now()` unless `AGENT_NOW` is set in the environment or `?now=` is passed on the session. All timestamps, date resolution, and the "today" line in the prompt go through it. This is how "last Tuesday" can be demonstrated honestly and how the seed script writes dated history.

### 4.8 Seed data

`npm run seed` writes three fabricated-but-realistic sessions through the real memory code path (so extraction and claims are exercised, not hand-written): a CRM shortlist on the most recent Monday, a Postgres hosting question on the most recent Tuesday, and a short unrelated session on 3 November. Each is clearly marked `seeded: true` in metadata and in the UI.

### 4.9 Browser UI

One static HTML file, vanilla JS, no build step. Research layout: left, a list of sessions with dates and a "new conversation" button (seeded sessions marked). Right, the chat. Each assistant turn renders in this order:

1. A sources row: one small card per cited source with domain, title, and date (or "undated").
2. For "what changed" answers, a diff table: item, previous value and date, current value and date, verdict (changed / same / unverified) with the citation number.
3. The prose answer, streamed, with inline citation markers that link to the source cards.

Above the answer, one collapsed chip when memory was used ("recalled 3 Nov session"); clicking it shows the remembered lines. The live status line during a turn shows the tool calls as they run ("searching: Neon pricing, since 3 Nov"). The header shows the clock's "today" and the active model, so the clock override and provider are never hidden.

The diff table is not parsed from prose. The system prompt asks for a small fenced JSON block (`items[]`) at the end of "what changed" answers; the server strips it from the text stream and sends it as a separate SSE event, and the browser renders it. If the block is missing or malformed the answer still displays, just without the table.

### 4.10 Module layout

```
src/server.ts            http + SSE, session routing, wires everything
src/clock.ts
src/agent/loop.ts        the streaming tool loop, provider-neutral
src/agent/prompt.ts      system prompt policy, recall block formatting
src/llm/types.ts         Msg, ToolSpec, LlmProvider
src/llm/anthropic.ts     Anthropic implementation (primary)
src/llm/gemini.ts        Gemini implementation (fallback, dev test target)
src/llm/select.ts        picks provider from env
src/tools/types.ts       SearchProvider interface, tool schemas
src/tools/exa.ts         SearchProvider implementation
src/tools/search.ts      web_search tool: dedupe, sort, trim, cap
src/tools/fetch.ts       fetch_url tool: extract, rank paragraphs, cache
src/memory/store.ts      JSONL read/write, in-memory indexes, contradiction rule
src/memory/recall.ts     date resolution + topic match + block assembly
src/memory/extract.ts    background claim extraction
public/index.html
scripts/seed.ts
eval/questions.json      ~20 questions incl. the three from the brief
eval/run.ts              runs them, LLM-judge scores correctness/citations/freshness
```

Each module has one dependency direction: server → agent → llm, server → agent → tools, server → memory → llm. Tools know nothing about memory or models; memory knows nothing about the loop; the loop knows nothing about which provider it is talking to.

## 5. Considered and rejected

- **Memory as a tool the model calls.** Rejected: adds a round trip to every turn, and the model sometimes skips it. Harness recall is deterministic and free.
- **Knowledge graph (Graphiti-style).** Rejected: the test questions are entity-and-date lookups, not multi-hop. Kept the one idea that matters, validity intervals on claims. Storage interface allows a graph backend later.
- **Vendor memory services (Mem0, Zep, Letta).** Rejected: a dependency for a weekend project, benchmark claims are vendor-reported and disputed, and they hide exactly the logic a reviewer wants to read.
- **Anthropic's server-side web search tool.** Rejected: can't control result formatting, dates, dedupe, or caps, and the search design is what's being judged.
- **Own chunk/embed/rerank pipeline.** Rejected: that's a retrieval product; near-zero cache hit rate means it only adds latency. Exa highlights give the passage stage in one call.
- **Semantic query cache.** Rejected: wrong for a freshness agent.
- **MCP, subagents, model-tier routing.** Rejected: more moving parts, no gain on this test set.
- **Writing the loop directly against the Anthropic SDK types (or the SDK tool runner).** Rejected only because two providers are required. The internal `Msg` type is the smallest seam that lets one loop serve both; it costs one mapping file per provider and nothing else.

## 5a. A known risk, stated plainly

Development and most testing run on Gemini 3.8 Flash because that is the key the author has. The Anthropic path is the intended primary and will be exercised before submission on a short trial key or by the reviewer. Consequences: the system prompt is kept plain and model-neutral rather than tuned to one model's quirks, the eval script takes `MODEL_PROVIDER` so the same questions run on both, and DESIGN.md says which provider each reported number came from.

## 6. With another week

Real eval loop (hill-climb the prompt against the question set with a judge), entity normalisation so "HubSpot" and "HubSpot Starter" link, per-source trust weighting, compaction for very long sessions, and a second provider for cross-checking contested facts.

## 7. Left to the builder

Exact prompt wording; tokeniser used for overlap scoring; SSE event shapes; how session ids are generated; UI styling; what the eval judge prompt looks like; TTL values; error copy.
