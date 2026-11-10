import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import type { LlmProvider } from "./types.ts";

/** MODEL_PROVIDER wins; otherwise the first provider with a key, Anthropic first. */
export function selectProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const wanted = env.MODEL_PROVIDER?.trim().toLowerCase() || (env.ANTHROPIC_API_KEY ? "anthropic" : env.GEMINI_API_KEY ? "gemini" : "");
  if (wanted === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("MODEL_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set (see .env.example).");
    return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, chatModel: env.ANTHROPIC_MODEL });
  }
  if (wanted === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("MODEL_PROVIDER=gemini but GEMINI_API_KEY is not set (see .env.example).");
    return new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
  }
  if (wanted) throw new Error(`Unknown MODEL_PROVIDER "${env.MODEL_PROVIDER}"; use "anthropic" or "gemini".`);
  throw new Error("No model key found. Copy .env.example to .env and set ANTHROPIC_API_KEY or GEMINI_API_KEY.");
}
