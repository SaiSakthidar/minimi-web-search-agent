// Entry point: load .env, pick the model provider, open memory, listen.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectProvider } from "./llm/select.ts";
import { LocalEmbedder } from "./memory/embed.ts";
import { MemoryStore } from "./memory/store.ts";
import { createApp } from "./server.ts";
import { ExaProvider } from "./tools/exa.ts";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Minimal .env reader: KEY=value lines, # comments, optional quotes. Real environment variables win. */
export function loadEnv(path = `${ROOT}.env`): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = value;
  }
}

export async function boot() {
  loadEnv();
  const provider = selectProvider(process.env);
  if (!process.env.EXA_API_KEY) throw new Error("EXA_API_KEY is not set. Copy .env.example to .env and add it (free key at dashboard.exa.ai).");
  const search = new ExaProvider(process.env.EXA_API_KEY);
  const store = await MemoryStore.open(`${ROOT}data`);
  // Semantic recall model: loads in the background (first run downloads ~34 MB); recall is keyword-only until then.
  const embedder = new LocalEmbedder();
  const t0 = Date.now();
  embedder.warm().then(
    () => console.log(`[recall] embedding model ready (${Date.now() - t0} ms)`),
    (e) => console.warn(`[recall] embedding model unavailable, using keyword recall only: ${(e as Error).message}`),
  );
  return { provider, search, store, embedder };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const deps = await boot();
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || "127.0.0.1"; // local only by default: the server spends your API keys
    createApp(deps).listen(port, host, () => {
      console.log(`minimi on http://${host === "127.0.0.1" ? "localhost" : host}:${port}  (${deps.provider.name}: ${deps.provider.modelLabel}${process.env.AGENT_NOW ? `, clock ${process.env.AGENT_NOW}` : ""})`);
    });
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
}
