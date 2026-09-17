import type {
  CallOptions,
  ChatCompletion,
  ChatMessage,
  ChatModel,
  ChatStreamPart,
  FinishReason,
  ModelDescriptor,
  TokenUsage,
} from "../types.js";
import { AiError } from "../errors.js";

/**
 * Deterministic mock chat model: no network, no randomness. It builds its
 * answer from the first few sentences of the latest user message (which is
 * where retrieved context + the question will live once Phase 5 wires up
 * retrieval-augmented prompts) and appends [S1]-style citation markers, so
 * the whole app — UI, tests, CI — is exercisable with zero API keys.
 */

const MAX_CITED_SENTENCES = 3;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function extractSourceText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return messages[i]!.content;
    }
  }
  return messages.map((m) => m.content).join(" ");
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildAnswer(messages: ChatMessage[], maxOutputTokens?: number): { text: string; truncated: boolean } {
  const sentences = splitSentences(extractSourceText(messages));
  if (sentences.length === 0) {
    return { text: "No context was provided to answer from.", truncated: false };
  }

  const cited = sentences
    .slice(0, MAX_CITED_SENTENCES)
    .map((sentence, index) => `${sentence} [S${index + 1}]`)
    .join(" ");

  if (maxOutputTokens !== undefined && estimateTokens(cited) > maxOutputTokens) {
    const maxChars = Math.max(1, maxOutputTokens * 4);
    return { text: cited.slice(0, maxChars), truncated: true };
  }
  return { text: cited, truncated: false };
}

function usageFor(promptText: string, completionText: string): TokenUsage {
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

export class MockChatModel implements ChatModel {
  readonly descriptor: ModelDescriptor;

  constructor(model = "mock-chat") {
    this.descriptor = { provider: "mock", model, baseUrl: "mock://local" };
  }

  async complete(messages: ChatMessage[], opts: CallOptions = {}): Promise<ChatCompletion> {
    if (opts.signal?.aborted) {
      throw new AiError("aborted", "Request aborted.", { provider: "mock" });
    }
    const { text, truncated } = buildAnswer(messages, opts.maxOutputTokens);
    const finishReason: FinishReason = truncated ? "length" : "stop";
    return {
      text,
      usage: usageFor(messages.map((m) => m.content).join(" "), text),
      finishReason,
    };
  }

  async *stream(messages: ChatMessage[], opts: CallOptions = {}): AsyncIterable<ChatStreamPart> {
    const promptText = messages.map((m) => m.content).join(" ");
    const { text, truncated } = buildAnswer(messages, opts.maxOutputTokens);
    const words = text.split(" ");
    let emitted = "";

    for (const word of words) {
      if (opts.signal?.aborted) {
        yield { type: "finish", usage: usageFor(promptText, emitted), finishReason: "aborted" };
        return;
      }
      const delta = emitted.length === 0 ? word : ` ${word}`;
      emitted += delta;
      yield { type: "text-delta", text: delta };
    }

    yield {
      type: "finish",
      usage: usageFor(promptText, emitted),
      finishReason: truncated ? "length" : "stop",
    };
  }
}
