import { expect, it } from "vitest";

import { isAiError } from "./errors.js";
import type { ChatModel, ChatMessage, EmbeddingModel } from "./types.js";

/**
 * Shared behavioral contract every ChatModel implementation must satisfy,
 * regardless of provider. Call it from a `describe` block with a factory
 * that builds a fresh model instance:
 *
 *   describe("MockChatModel", () => runChatModelContract(() => new MockChatModel()));
 *
 * Run against the mock models unconditionally, and against the
 * OpenAI-compatible adapter with MSW stubbing the HTTP layer.
 */
export function runChatModelContract(makeModel: () => ChatModel): void {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Say hello. This is a test. Please respond briefly." },
  ];

  it("complete() returns non-negative usage and a valid finish reason", async () => {
    const model = makeModel();
    const result = await model.complete(messages);
    expect(typeof result.text).toBe("string");
    expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);
    expect(["stop", "length", "aborted", "other"]).toContain(result.finishReason);
  });

  it("stream() yields text-deltas then exactly one finish part", async () => {
    const model = makeModel();
    const parts = [];
    for await (const part of model.stream(messages)) {
      parts.push(part);
    }
    const finishes = parts.filter((p) => p.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(parts.at(-1)?.type).toBe("finish");
    for (const part of parts.slice(0, -1)) {
      expect(part.type).toBe("text-delta");
    }
  });

  it("stream() honors an already-aborted signal with exactly one finish(aborted)", async () => {
    const model = makeModel();
    const controller = new AbortController();
    controller.abort();
    const parts = [];
    for await (const part of model.stream(messages, { signal: controller.signal })) {
      parts.push(part);
    }
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "finish", finishReason: "aborted" });
  });

  it("complete() rejects with an AiError when already aborted", async () => {
    const model = makeModel();
    const controller = new AbortController();
    controller.abort();
    await expect(model.complete(messages, { signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => isAiError(error),
    );
  });

  it("descriptor reports a provider, model, and baseUrl", () => {
    const model = makeModel();
    expect(model.descriptor.provider.length).toBeGreaterThan(0);
    expect(model.descriptor.model.length).toBeGreaterThan(0);
    expect(model.descriptor.baseUrl.length).toBeGreaterThan(0);
  });
}

/**
 * Shared behavioral contract every EmbeddingModel implementation must
 * satisfy. Same usage pattern as runChatModelContract.
 */
export function runEmbeddingModelContract(makeModel: () => EmbeddingModel): void {
  it("embed() returns one vector per input, each matching descriptor.dimensions", async () => {
    const model = makeModel();
    const inputs = ["the quick brown fox", "jumps over the lazy dog", "hello world"];
    const { vectors, usage } = await model.embed(inputs);
    expect(vectors).toHaveLength(inputs.length);
    for (const vector of vectors) {
      expect(vector).toHaveLength(model.descriptor.dimensions);
    }
    expect(usage.promptTokens).toBeGreaterThanOrEqual(0);
    expect(usage.totalTokens).toBeGreaterThanOrEqual(0);
  });

  it("embed() rejects an empty input list with an AiError", async () => {
    const model = makeModel();
    await expect(model.embed([])).rejects.toSatisfy((error: unknown) => isAiError(error));
  });

  it("descriptor reports dimensions alongside provider/model/baseUrl", () => {
    const model = makeModel();
    expect(model.descriptor.dimensions).toBeGreaterThan(0);
    expect(model.descriptor.provider.length).toBeGreaterThan(0);
  });
}
