// Local sentence embeddings for recall. Runs bge-small-en-v1.5 (33M params, ~34 MB quantised) in-process
// through Transformers.js, so semantic recall works the same with any chat provider and needs no key.
// The model downloads once on first use into .cache/models; if that fails, recall stays keyword-only.

import { fileURLToPath } from "node:url";

export interface Embedder {
  readonly id: string;
  /** L2-normalised vectors, so cosine similarity is a dot product. */
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

export const cosine = (a: number[], b: number[]) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};

const MODEL = "Xenova/bge-small-en-v1.5";
/** bge's instruction for short queries against passages; documents are embedded as-is. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const CACHE_DIR = fileURLToPath(new URL("../../.cache/models/", import.meta.url));

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: true }) => Promise<{ tolist(): number[][] }>;

export class LocalEmbedder implements Embedder {
  readonly id = MODEL;
  private extractor: Promise<Extractor> | null = null;
  private docCache = new Map<string, number[]>();

  /** Starts loading (and on first run, downloading) the model; safe to call repeatedly. */
  warm(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = CACHE_DIR;
      return (await pipeline("feature-extraction", MODEL, { dtype: "q8" })) as unknown as Extractor;
    })();
    this.extractor.catch(() => { this.extractor = null; }); // allow a later retry
    return this.extractor;
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    const extractor = await this.warm();
    if (kind === "query") return (await extractor(texts.map((t) => QUERY_PREFIX + t), { pooling: "cls", normalize: true })).tolist();
    const missing = [...new Set(texts.filter((t) => !this.docCache.has(t)))];
    if (missing.length) {
      const vecs = (await extractor(missing, { pooling: "cls", normalize: true })).tolist();
      missing.forEach((t, i) => this.docCache.set(t, vecs[i]));
    }
    return texts.map((t) => this.docCache.get(t)!);
  }
}
