/**
 * @kb/ai
 *
 * The provider-agnostic AI layer. Application code depends on two small
 * interfaces (`ChatModel`, `EmbeddingModel`); which vendor sits behind them
 * is decided entirely by environment variables (see docs/PROVIDERS.md).
 * `openai-compatible/` is the ONLY place in this package (and the whole
 * repo) allowed to import the `openai` SDK directly — enforced by an eslint
 * rule and by Gate 2's grep check.
 */

export const KB_AI_VERSION = "0.2.0-phase2";

export type {
  Role,
  ChatMessage,
  CallOptions,
  TokenUsage,
  ModelDescriptor,
  FinishReason,
  ChatCompletion,
  ChatStreamPart,
  ChatModel,
  EmbeddingModel,
} from "./types.js";

export { AiError, AI_ERROR_CODES, RETRYABLE_AI_ERROR_CODES, isAiError } from "./errors.js";
export type { AiErrorCode, AiErrorOptions } from "./errors.js";

export { PROVIDER_NAMES, PROVIDER_PRESETS } from "./presets.js";
export type { ProviderName, ProviderPreset, ProviderCapabilities } from "./presets.js";

export { resolveAiConfig, REQUIRED_EMBEDDING_DIMENSIONS } from "./config.js";
export type {
  ResolvedAiConfig,
  ResolvedChatConfig,
  ResolvedEmbeddingConfig,
  ResolvedProviderConfig,
} from "./config.js";

export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";

export { createAi } from "./create-ai.js";
export type { Ai, AiDescriptor } from "./create-ai.js";

export { MockChatModel } from "./mock/mock-chat-model.js";
export { MockEmbeddingModel, hashEmbed } from "./mock/mock-embedding-model.js";

export { OpenAiCompatibleChatModel } from "./openai-compatible/chat-model.js";
export type { OpenAiCompatibleChatModelOptions } from "./openai-compatible/chat-model.js";
export { OpenAiCompatibleEmbeddingModel } from "./openai-compatible/embedding-model.js";
export type { OpenAiCompatibleEmbeddingModelOptions } from "./openai-compatible/embedding-model.js";
export { mapOpenAiError } from "./openai-compatible/map-error.js";
