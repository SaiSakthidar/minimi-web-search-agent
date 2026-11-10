// npm run seed: writes three dated, clearly-marked sessions through the same
// turn path the server uses (real model, real search, real extraction), so
// "On Monday...", "Last Tuesday..." and "on 3 November" have history to recall.

import { fileURLToPath } from "node:url";
import { dayKey, getOverride, now, setOverride } from "../src/clock.ts";
import type { LlmProvider } from "../src/llm/types.ts";
import { awaitExtractions } from "../src/memory/extract.ts";
import { resolveDates } from "../src/memory/recall.ts";
import type { MemoryStore } from "../src/memory/store.ts";
import { fetchTool } from "../src/tools/fetch.ts";
import { searchTool } from "../src/tools/search.ts";
import type { SearchProvider } from "../src/tools/types.ts";
import { handleTurn } from "../src/turn.ts";

/** `when` is resolved with the same date parser recall uses, so the seeded day is the day the phrase means. */
export const SEED_SESSIONS = [
  {
    when: "3 November", hour: 9, title: "Unrelated: best laptop for travel",
    turns: ["What's a good lightweight laptop for frequent travel, under $1,500? Give me two or three picks with current prices."],
  },
  {
    when: "last Tuesday", hour: 10, title: "Managed Postgres hosting",
    turns: ["Which managed Postgres hosting should a small team use? Compare the entry paid plans of Supabase, Neon and Railway with their monthly prices."],
  },
  {
    when: "on Monday", hour: 11, title: "CRM shortlist for a 20-person sales team",
    turns: ["We're a 20-person sales team choosing a CRM. Shortlist 5 tools (for example HubSpot, Pipedrive, Salesforce, Zoho, Close) with their current per-seat monthly pricing for a mid tier plan."],
  },
] as const;

export async function seed(
  deps: { provider: LlmProvider; search: SearchProvider; store: MemoryStore },
  opts: { force?: boolean; log?: (s: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? console.log;
  const { store } = deps;
  if (!opts.force && store.listSessions().some((s) => s.seeded)) {
    throw new Error("data/ already has seeded sessions. Delete data/ to start over, or pass --force to add another set.");
  }
  const tools = [searchTool(deps.search), fetchTool(deps.search)];
  const base = now();
  const previous = getOverride();
  try {
    for (const s of SEED_SESSIONS) {
      const day = resolveDates(s.when, base)[0]?.day;
      if (!day) throw new Error(`Could not resolve "${s.when}"`);
      const at = (minute: number) => new Date(`${day}T${String(s.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`).toISOString();
      setOverride(at(0));
      const session = await deps.store.createSession({ startedAt: at(0), seeded: true });
      log(`\n${day}  ${s.title}`);
      for (const [i, text] of s.turns.entries()) {
        setOverride(at(i * 5 + 1));
        log(`  user: ${text}`);
        const result = await handleTurn({ ...deps, tools, log: (e) => log(`  extraction failed: ${(e as Error).message}`) }, session.id, text, () => {});
        log(`  assistant: ${result.text.slice(0, 160).replace(/\s+/g, " ")}${result.text.length > 160 ? "…" : ""}  (${result.cited.length} sources)`);
        await awaitExtractions();
      }
      if (!store.getSession(session.id)?.title) await store.updateSession(session.id, { title: s.title });
    }
  } finally {
    setOverride(previous);
  }
  log(`\nSeeded ${SEED_SESSIONS.length} sessions; ${store.claims().length} claims in memory. Today is ${dayKey(now())}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { boot } = await import("../src/main.ts");
  try {
    const deps = await boot();
    await seed(deps, { force: process.argv.includes("--force") });
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
}
