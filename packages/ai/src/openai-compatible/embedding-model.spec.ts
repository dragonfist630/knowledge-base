import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runEmbeddingModelContract } from "../contract.js";
import { isAiError } from "../errors.js";
import { PROVIDER_PRESETS } from "../presets.js";
import type { ProviderCapabilities } from "../presets.js";
import {
  OpenAiCompatibleEmbeddingModel,
  type OpenAiCompatibleEmbeddingModelOptions,
} from "./embedding-model.js";
import { defaultEmbeddingHandler, FAKE_BASE_URL, server } from "./test-support/msw-server.js";

const FULL_CAPABILITIES: ProviderCapabilities = PROVIDER_PRESETS.openai.capabilities;

function makeModel(
  overrides: Partial<OpenAiCompatibleEmbeddingModelOptions> = {},
): OpenAiCompatibleEmbeddingModel {
  return new OpenAiCompatibleEmbeddingModel({
    provider: "fake",
    model: "fake-embedding-model",
    baseUrl: FAKE_BASE_URL,
    apiKey: "test-key",
    capabilities: FULL_CAPABILITIES,
    dimensions: 1536,
    requestTimeoutMs: 5_000,
    maxRetries: 0,
    ...overrides,
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("OpenAiCompatibleEmbeddingModel", () => {
  describe("contract", () => runEmbeddingModelContract(() => makeModel()));

  it("sends a dimensions param when capabilities.embeddingDimensionsParam is true", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${FAKE_BASE_URL}/embeddings`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          object: "list",
          model: "fake-embedding-model",
          data: [{ object: "embedding", index: 0, embedding: new Array(1536).fill(0) }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
      }),
    );
    const model = makeModel({ capabilities: { ...FULL_CAPABILITIES, embeddingDimensionsParam: true } });
    await model.embed(["hello"]);
    expect(capturedBody?.dimensions).toBe(1536);
  });

  it("omits the dimensions param when capabilities.embeddingDimensionsParam is false", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${FAKE_BASE_URL}/embeddings`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          object: "list",
          model: "fake-embedding-model",
          data: [{ object: "embedding", index: 0, embedding: new Array(1536).fill(0) }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
      }),
    );
    const model = makeModel({ capabilities: { ...FULL_CAPABILITIES, embeddingDimensionsParam: false } });
    await model.embed(["hello"]);
    expect(capturedBody?.dimensions).toBeUndefined();
  });

  it("splits inputs into batches and preserves original order across concurrent requests", async () => {
    let requestCount = 0;
    server.use(
      http.post(`${FAKE_BASE_URL}/embeddings`, async ({ request }) => {
        requestCount += 1;
        // Stagger responses so batches genuinely race and can complete out of order.
        await new Promise((r) => setTimeout(r, requestCount % 2 === 0 ? 30 : 5));
        const body = (await request.json()) as { input: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return HttpResponse.json({
          object: "list",
          model: "fake-embedding-model",
          data: inputs.map((input, index) => ({
            object: "embedding" as const,
            index,
            // Encode each input's length into the vector so we can verify
            // the final array matches the original input order exactly.
            embedding: new Array(4).fill(0).map((_, i) => (i === 0 ? input.length : 0)),
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        });
      }),
    );

    const inputs = ["a", "bb", "ccc", "dddd", "eeeee"];
    const model = makeModel({ dimensions: 4, batchSize: 2, concurrency: 2 });
    const { vectors, usage } = await model.embed(inputs);

    expect(vectors).toHaveLength(inputs.length);
    for (const [i, input] of inputs.entries()) {
      expect(vectors[i]?.[0]).toBe(input.length);
    }
    expect(requestCount).toBe(3); // 5 inputs / batchSize 2 -> 3 batches
    expect(usage.promptTokens).toBe(inputs.length);
  });

  it("falls back to estimated usage when the provider omits usage", async () => {
    server.use(
      http.post(`${FAKE_BASE_URL}/embeddings`, () =>
        HttpResponse.json({
          object: "list",
          model: "fake-embedding-model",
          data: [{ object: "embedding", index: 0, embedding: new Array(1536).fill(0) }],
          // no usage field
        }),
      ),
    );
    const model = makeModel();
    const { usage } = await model.embed(["hello world"]);
    expect(usage.estimated).toBe(true);
    expect(usage.promptTokens).toBeGreaterThan(0);
  });

  it("throws invalid_response when the provider returns vectors of the wrong dimension", async () => {
    server.use(
      http.post(`${FAKE_BASE_URL}/embeddings`, () =>
        HttpResponse.json({
          object: "list",
          model: "fake-embedding-model",
          data: [{ object: "embedding", index: 0, embedding: new Array(42).fill(0) }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      ),
    );
    const model = makeModel({ dimensions: 1536 });
    const error = await model.embed(["hello"]).catch((e: unknown) => e);
    expect(isAiError(error)).toBe(true);
    if (isAiError(error)) {
      expect(error.code).toBe("invalid_response");
    }
  });

  it("throws invalid_response when the provider returns the wrong number of vectors", async () => {
    server.use(
      http.post(`${FAKE_BASE_URL}/embeddings`, () =>
        HttpResponse.json({
          object: "list",
          model: "fake-embedding-model",
          data: [{ object: "embedding", index: 0, embedding: new Array(1536).fill(0) }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      ),
    );
    const model = makeModel();
    const error = await model.embed(["hello", "world"]).catch((e: unknown) => e);
    expect(isAiError(error)).toBe(true);
    if (isAiError(error)) {
      expect(error.code).toBe("invalid_response");
    }
  });

  it("maps an upstream 429 to a retryable rate_limit AiError", async () => {
    server.use(
      http.post(`${FAKE_BASE_URL}/embeddings`, () =>
        HttpResponse.json({ error: { message: "slow down" } }, { status: 429 }),
      ),
    );
    const model = makeModel();
    const error = await model.embed(["hello"]).catch((e: unknown) => e);
    expect(isAiError(error)).toBe(true);
    if (isAiError(error)) {
      expect(error.code).toBe("rate_limit");
    }
  });

  it("works end-to-end against the shared default handler", async () => {
    server.use(defaultEmbeddingHandler);
    const model = makeModel();
    const { vectors } = await model.embed(["one", "two", "three"]);
    expect(vectors).toHaveLength(3);
  });
});
