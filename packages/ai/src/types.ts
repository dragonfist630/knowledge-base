/**
 * Domain types for the provider-agnostic AI layer. Deliberately has NO
 * `openai` import anywhere in this file (or anywhere outside
 * `openai-compatible/`) — application code, tests, and the mock models all
 * depend only on these interfaces.
 */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CallOptions {
  /** Propagated to the underlying HTTP request; aborting stops mid-stream. */
  signal?: AbortSignal;
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * true when the provider didn't report usage (e.g. capabilities.streamUsage
   * is false) and we estimated it with a tokenizer instead.
   */
  estimated: boolean;
}

export interface ModelDescriptor {
  provider: string;
  model: string;
  baseUrl: string;
}

export type FinishReason = "stop" | "length" | "aborted" | "other";

export interface ChatCompletion {
  text: string;
  usage: TokenUsage;
  finishReason: FinishReason;
}

export type ChatStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "finish"; usage: TokenUsage; finishReason: FinishReason };

export interface ChatModel {
  readonly descriptor: ModelDescriptor;
  complete(messages: ChatMessage[], opts?: CallOptions): Promise<ChatCompletion>;
  /** MUST always end with exactly one `finish` part, even on abort/error paths. */
  stream(messages: ChatMessage[], opts?: CallOptions): AsyncIterable<ChatStreamPart>;
}

export interface EmbeddingModel {
  readonly descriptor: ModelDescriptor & { dimensions: number };
  embed(
    inputs: string[],
    opts?: CallOptions,
  ): Promise<{ vectors: number[][]; usage: TokenUsage }>;
}
