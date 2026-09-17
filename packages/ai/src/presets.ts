/**
 * Provider registry — pure data, no logic. Supporting a new OpenAI-compatible
 * vendor that fits this shape takes zero code: either point AI_*_BASE_URL at
 * it with provider "custom", or add one entry here.
 *
 * Verified against each vendor's current docs on 2026-09-17 (see
 * docs/DECISIONS.md D2.x for the diff against the original brief, which was
 * written earlier in 2026 — two capabilities had already changed by then).
 */

export interface ProviderCapabilities {
  chat: boolean;
  embeddings: boolean;
  /** Whether `stream_options: { include_usage: true }` is honored on chat completions. */
  streamUsage: boolean;
  /** Whether the embeddings endpoint accepts a `dimensions` param. */
  embeddingDimensionsParam: boolean;
}

export interface ProviderPreset {
  /** undefined only for "custom" (AI_*_BASE_URL is required instead) and "mock" (no network). */
  baseUrl: string | undefined;
  /** Env var this preset's API key is read from, when the provider needs one. */
  apiKeyEnv: string | undefined;
  requiresKey: boolean;
  capabilities: ProviderCapabilities;
}

export const PROVIDER_NAMES = [
  "openai",
  "groq",
  "together",
  "openrouter",
  "ollama",
  "custom",
  "mock",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const PROVIDER_PRESETS: Record<ProviderName, ProviderPreset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    requiresKey: true,
    capabilities: { chat: true, embeddings: true, streamUsage: true, embeddingDimensionsParam: true },
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    requiresKey: true,
    // Groq's endpoint list (chat completions, responses, audio, models,
    // batches, files, fine-tuning) has no /embeddings route — unchanged from
    // the brief, reconfirmed 2026-09-17.
    capabilities: { chat: true, embeddings: false, streamUsage: true, embeddingDimensionsParam: false },
  },
  together: {
    // Was api.together.xyz in the original brief; Together's current docs
    // (2026-09-17) canonicalize on the .ai domain. .xyz still resolves, but
    // point new code at the documented one — see docs/DECISIONS.md D2.1.
    baseUrl: "https://api.together.ai/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    requiresKey: true,
    capabilities: { chat: true, embeddings: true, streamUsage: true, embeddingDimensionsParam: false },
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    requiresKey: true,
    // The brief (written earlier in 2026) had embeddings: false. OpenRouter
    // shipped a stable POST /api/v1/embeddings since then — reconfirmed
    // 2026-09-17 against openrouter.ai/docs/api_reference/embeddings. See
    // docs/DECISIONS.md D2.1.
    capabilities: { chat: true, embeddings: true, streamUsage: true, embeddingDimensionsParam: false },
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: undefined,
    requiresKey: false,
    // streamUsage kept false deliberately: Ollama's OpenAI-compat layer
    // accepting stream_options doesn't guarantee the reported usage is
    // trustworthy across the many models/versions users run locally, and
    // getting this wrong silently (reporting inaccurate real usage instead
    // of an honestly-estimated one) is worse than always estimating. See
    // docs/DECISIONS.md D2.1.
    capabilities: { chat: true, embeddings: true, streamUsage: false, embeddingDimensionsParam: false },
  },
  custom: {
    baseUrl: undefined,
    apiKeyEnv: undefined,
    requiresKey: false,
    capabilities: { chat: true, embeddings: true, streamUsage: false, embeddingDimensionsParam: false },
  },
  mock: {
    baseUrl: undefined,
    apiKeyEnv: undefined,
    requiresKey: false,
    capabilities: { chat: true, embeddings: true, streamUsage: false, embeddingDimensionsParam: false },
  },
};
