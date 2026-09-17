import { resolveAiConfig, type ResolvedAiConfig } from "./config.js";
import { MockChatModel } from "./mock/mock-chat-model.js";
import { MockEmbeddingModel } from "./mock/mock-embedding-model.js";
import { OpenAiCompatibleChatModel } from "./openai-compatible/chat-model.js";
import { OpenAiCompatibleEmbeddingModel } from "./openai-compatible/embedding-model.js";
import type { ChatModel, EmbeddingModel } from "./types.js";

export interface AiDescriptor {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyMasked: string | undefined;
}

export interface Ai {
  chat: ChatModel;
  embeddings: EmbeddingModel;
  /** Human-readable summary for logs/CLI output — never includes a raw key. */
  describe(): { chat: AiDescriptor; embedding: AiDescriptor & { dimensions: number } };
}

function maskKey(key: string | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  if (key.length <= 8) {
    return "*".repeat(key.length);
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function buildChatModel(config: ResolvedAiConfig): ChatModel {
  if (config.chat.provider === "mock") {
    return new MockChatModel(config.chat.model);
  }
  return new OpenAiCompatibleChatModel({
    provider: config.chat.provider,
    model: config.chat.model,
    baseUrl: config.chat.baseUrl,
    apiKey: config.chat.apiKey,
    capabilities: config.chat.capabilities,
    supportsTemperature: config.chat.supportsTemperature,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
}

function buildEmbeddingModel(config: ResolvedAiConfig): EmbeddingModel {
  if (config.embedding.provider === "mock") {
    return new MockEmbeddingModel(config.embedding.model, config.embedding.dimensions);
  }
  return new OpenAiCompatibleEmbeddingModel({
    provider: config.embedding.provider,
    model: config.embedding.model,
    baseUrl: config.embedding.baseUrl,
    apiKey: config.embedding.apiKey,
    capabilities: config.embedding.capabilities,
    dimensions: config.embedding.dimensions,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
}

/**
 * The one entry point application code should use: reads env, validates it
 * (throwing one aggregated AiError if anything's wrong), and wires up the
 * right ChatModel/EmbeddingModel — mock or a real OpenAI-compatible provider
 * — behind the same two interfaces either way.
 */
export function createAi(env: NodeJS.ProcessEnv = process.env): Ai {
  const config = resolveAiConfig(env);
  const chat = buildChatModel(config);
  const embeddings = buildEmbeddingModel(config);

  return {
    chat,
    embeddings,
    describe: () => ({
      chat: {
        provider: config.chat.provider,
        model: config.chat.model,
        baseUrl: config.chat.baseUrl,
        apiKeyMasked: maskKey(config.chat.apiKey),
      },
      embedding: {
        provider: config.embedding.provider,
        model: config.embedding.model,
        baseUrl: config.embedding.baseUrl,
        dimensions: config.embedding.dimensions,
        apiKeyMasked: maskKey(config.embedding.apiKey),
      },
    }),
  };
}
