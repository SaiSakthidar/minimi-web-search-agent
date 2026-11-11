# minimi

A chat agent with one capability, web search, that remembers earlier conversations and re-checks what it said before. Ask "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it recalls that session, searches each price again, and shows what changed with dated sources.

## Run it

```bash
cp .env.example .env    # add EXA_API_KEY and one of GEMINI_API_KEY / ANTHROPIC_API_KEY
npm install
npm run seed            # optional: three dated example sessions (needs the keys; ~1 minute)
npm run dev             # http://localhost:3000
```

Node 20 or newer. The first start downloads a 34 MB embedding model into `.cache/models` for semantic recall; until it is ready, recall matches by keywords only. Keys:

| Key | Needed | Where |
| --- | --- | --- |
| `EXA_API_KEY` | yes | [dashboard.exa.ai](https://dashboard.exa.ai/api-keys), free credits on signup |
| `GEMINI_API_KEY` | one model key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey), free tier |
| `ANTHROPIC_API_KEY` | one model key | [console.anthropic.com](https://console.anthropic.com/settings/keys) |

With both model keys set, Anthropic (`claude-opus-5-5`) is used. `MODEL_PROVIDER=gemini` forces Gemini (`gemini-3.8-flash`). The header in the UI always shows the active model.

## Try the memory questions

`npm run seed` writes three sessions marked *seeded*, through the same code path a real chat uses:

- a laptop question on 3 November,
- a Postgres hosting comparison on the day "last Tuesday" means,
- a CRM shortlist on the day "on Monday" means.

Then ask the three questions on the empty screen. To replay the demo on another day, set `AGENT_NOW=2026-11-10T12:00:00` in `.env`. The UI shows the override in the header. Seeding again needs `--force` or an empty `data/`.

## What is where

```
src/main.ts           .env, provider choice, listen
src/server.ts         HTTP + SSE routes
src/turn.ts           one turn: recall, loop, persist, extract (shared by server, seed, eval)
src/agent/            the provider-neutral tool loop and the system prompt
src/llm/              Msg types, Anthropic and Gemini providers, provider selection
src/tools/            web_search and fetch_url over a SearchProvider (Exa)
src/memory/           JSONL store, recall by date and topic, claim extraction
public/               the browser UI, no build step
scripts/seed.ts       dated example sessions
eval/                 20 questions and an LLM-judged runner
```

`data/` holds everything the agent remembers: `sessions/<id>.jsonl` is the full transcript per conversation, and `claims.jsonl` holds cited facts with the date they were observed and, once contradicted, the date they stopped being true. Delete the folder to start fresh.

## Tests and eval

```bash
npm test                # unit and HTTP tests, no network, no keys
npm run typecheck
npm run eval            # all 20 questions against the configured provider
npm run eval brief-postgres no-record   # selected questions by id
```

The eval runs on a throwaway copy of `data/`, so seeded memory is visible but nothing is written back. Results go to `eval/results-<provider>-<time>.json`.

Design notes: `DESIGN.md`.
