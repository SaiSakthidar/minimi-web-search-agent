// npm run eval: runs eval/questions.json against the configured provider, each
// question in a fresh session over a throwaway copy of data/ (seeded memory is
// visible, nothing is written back). An LLM judge grades each answer.

import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { now } from "../src/clock.ts";
import { GeminiProvider } from "../src/llm/gemini.ts";
import type { LlmProvider } from "../src/llm/types.ts";
import type { Embedder } from "../src/memory/embed.ts";
import { awaitExtractions } from "../src/memory/extract.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { fetchTool } from "../src/tools/fetch.ts";
import { searchTool } from "../src/tools/search.ts";
import type { SearchProvider } from "../src/tools/types.ts";
import { handleTurn } from "../src/turn.ts";

export type Question = { id: string; text: string; needsSearch: boolean; expects: string[] };
export type EvalRow = {
  id: string; firstTokenMs: number | null; totalMs: number; rounds: number; searches: number; fetches: number;
  diff: boolean; searchedAsExpected: boolean; correct: boolean | null; cited: boolean | null; notes: string; answer: string;
  /** The turn itself failed: no answer to grade. */
  error?: string;
  /** The answer exists but grading failed (e.g. the judge model was overloaded); correct/cited stay null. */
  judgeError?: string;
};

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    correct: { type: "boolean", description: "The answer meets the expectations and states nothing that contradicts its sources" },
    cited: { type: "boolean", description: "Every factual claim about the world carries a [n] citation (true if no world facts are stated)" },
    notes: { type: "string", description: "One sentence on what is missing or wrong" },
  },
  required: ["correct", "cited", "notes"],
  additionalProperties: false,
};

const JUDGE_SYSTEM =
  "You grade answers from a research chat assistant. The assistant has persistent memory of earlier conversations: " +
  "before each question it is shown what was asked and answered on earlier days, so statements about earlier " +
  "conversations are recalled, not invented, and must not count against it. Grade only against the expectations " +
  "and the cited sources. Be strict about facts about the world: each needs a [n] citation and must not contradict " +
  "its source. Questions about the assistant itself, greetings and arithmetic need no citations.";

export async function runEval(
  deps: { provider: LlmProvider; search: SearchProvider; store: MemoryStore; embedder?: Embedder; judge?: LlmProvider },
  questions: Question[], log: (s: string) => void = () => {},
): Promise<EvalRow[]> {
  const judge = deps.judge ?? deps.provider;
  const tools = [searchTool(deps.search), fetchTool(deps.search)];
  const rows: EvalRow[] = [];
  for (const q of questions) {
    const session = await deps.store.createSession({ startedAt: now().toISOString() });
    const t0 = performance.now();
    let firstTokenMs: number | null = null;
    let searches = 0, fetches = 0;
    const row: EvalRow = { id: q.id, firstTokenMs: null, totalMs: 0, rounds: 0, searches: 0, fetches: 0, diff: false, searchedAsExpected: false, correct: null, cited: null, notes: "", answer: "" };
    try {
      const result = await handleTurn({ provider: deps.provider, store: deps.store, embedder: deps.embedder, tools, log: () => {} }, session.id, q.text, (e) => {
        if (e.type === "text" && firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
        if (e.type === "status" && e.text.startsWith("searching")) searches++;
        if (e.type === "status" && e.text.startsWith("reading")) fetches++;
      });
      Object.assign(row, { totalMs: Math.round(performance.now() - t0), rounds: result.rounds, diff: !!result.diff, answer: result.text });
      await awaitExtractions();
      const sources = result.cited.map((s) => `[${s.id}] ${s.title} (${s.url}, ${s.publishedDate ?? "undated"})`).join("\n") || "(none)";
      try {
        const verdict = await judge.completeJson<{ correct: boolean; cited: boolean; notes: string }>({
          system: JUDGE_SYSTEM + " Today is " + now().toISOString().slice(0, 10) + ".",
          prompt: `Question:\n${q.text}\n\nExpectations:\n- ${q.expects.join("\n- ")}\n\nAnswer:\n${result.text}\n\nCited sources:\n${sources}`,
          schema: JUDGE_SCHEMA,
        });
        Object.assign(row, verdict);
      } catch (e) {
        row.judgeError = (e as Error).message; // keep the answer; only the grade is missing
      }
    } catch (e) {
      row.totalMs = Math.round(performance.now() - t0);
      row.error = (e as Error).message;
    }
    Object.assign(row, { firstTokenMs, searches, fetches, searchedAsExpected: q.needsSearch === searches > 0 });
    rows.push(row);
    const grade = row.judgeError ? "UNGRADED" : row.correct ? "ok  " : "FAIL";
    log(`${q.id.padEnd(18)} ${row.error ? "ERROR " + row.error : `${grade} cited=${row.cited} searches=${searches} rounds=${row.rounds} first=${firstTokenMs}ms total=${row.totalMs}ms`}${row.judgeError ? `  (judge: ${row.judgeError})` : ""}`);
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { boot, ROOT } = await import("../src/main.ts");
  try {
    const deps = await boot();
    const scratch = await mkdtemp(join(tmpdir(), "minimi-eval-"));
    await cp(join(ROOT, "data"), scratch, { recursive: true }).catch(() => {});
    const store = await MemoryStore.open(scratch);
    // A stronger judge than the answering model, when configured (Gemini only; one call per question).
    const judgeModel = process.env.EVAL_JUDGE_MODEL;
    const judge = judgeModel && process.env.GEMINI_API_KEY ? new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: judgeModel }) : deps.provider;
    const questions: Question[] = (await import("./questions.json", { with: { type: "json" } })).default;
    const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    const picked = only.length ? questions.filter((q) => only.includes(q.id)) : questions;
    console.log(`Running ${picked.length} questions on ${deps.provider.name} (${deps.provider.modelLabel}), judged by ${judge.modelLabel}\n`);
    await deps.embedder.warm().catch(() => {});
    const rows = await runEval({ ...deps, store, judge }, picked, console.log);
    const graded = rows.filter((r) => !r.error && !r.judgeError);
    const n = graded.length || 1;
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    const summary = {
      provider: deps.provider.name, model: deps.provider.modelLabel, judge: judge.modelLabel, at: new Date().toISOString(),
      questions: rows.length, answered: rows.filter((r) => !r.error).length, graded: graded.length,
      correct: graded.filter((r) => r.correct).length / n,
      cited: graded.filter((r) => r.cited).length / n,
      searchedAsExpected: rows.filter((r) => !r.error && r.searchedAsExpected).length / (rows.filter((r) => !r.error).length || 1),
      medianFirstTokenMs: median(rows.flatMap((r) => (r.firstTokenMs === null ? [] : [r.firstTokenMs]))),
      medianTotalMs: median(rows.map((r) => r.totalMs)),
    };
    console.log("\n" + JSON.stringify(summary, null, 2));
    const file = join(ROOT, "eval", `results-${deps.provider.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(file, JSON.stringify({ summary, rows }, null, 2));
    console.log(`\nWrote ${file}`);
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
}
