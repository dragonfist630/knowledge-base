import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runChatModelContract } from "../contract.js";
import { isAiError } from "../errors.js";
import { PROVIDER_PRESETS } from "../presets.js";
import type { ProviderCapabilities } from "../presets.js";
import { OpenAiCompatibleChatModel, type OpenAiCompatibleChatModelOptions } from "./chat-model.js";
import { defaultChatHandler, FAKE_BASE_URL, server } from "./test-support/msw-server.js";

const FULL_CAPABILITIES: ProviderCapabilities = PROVIDER_PRESETS.openai.capabilities;

function makeModel(overrides: Partial<OpenAiCompatibleChatModelOptions> = {}): OpenAiCompatibleChatModel {
  return new OpenAiCompatibleChatModel({
    provider: "fake",
    model: "fake-model",
    baseUrl: FAKE_BASE_URL,
    apiKey: "test-key",
    capabilities: FULL_CAPABILITIES,
    supportsTemperature: true,
    requestTimeoutMs: 5_000,
    maxRetries: 0,
    ...overrides,
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("OpenAiCompatibleChatModel", () => {
  describe("contract", () => runChatModelContract(() => makeModel()));

  it("sends temperature when supportsTemperature is true and the caller asked for one", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${FAKE_BASE_URL}/chat/completions`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }),
    );

    const model = makeModel({ supportsTemperature: true });
    await model.complete([{ role: "user", content: "hi" }], { temperature: 0.7 });
    expect(capturedBody?.temperature).toBe(0.7);
  });

  it("omits temperature entirely when supportsTemperature is false, even if the caller asked for one", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${FAKE_BASE_URL}/chat/completions`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }),
    );

    const model = makeModel({ supportsTemperature: false });
    await model.complete([{ role: "user", content: "hi" }], { temperature: 0.7 });
    expect(capturedBody?.temperature).toBeUndefined();
  });

  it("requests stream_options.include_usage when capabilities.streamUsage is true, and gets real (non-estimated) usage back", async () => {
    server.use(defaultChatHandler);
    const model = makeModel({ capabilities: { ...FULL_CAPABILITIES, streamUsage: true } });
    let finish;
    for await (const part of model.stream([{ role: "user", content: "hi" }])) {
      if (part.type === "finish") finish = part;
    }
    expect(finish?.usage.estimated).toBe(false);
  });

  it("does not request stream_options when capabilities.streamUsage is false, and falls back to estimated usage", async () => {
    server.use(defaultChatHandler);
    const model = makeModel({ capabilities: { ...FULL_CAPABILITIES, streamUsage: false } });
    let finish;
    for await (const part of model.stream([{ role: "user", content: "hi" }])) {
      if (part.type === "finish") finish = part;
    }
    expect(finish?.usage.estimated).toBe(true);
  });

  it("reassembles the streamed text from deltas to match the fixture's full message", async () => {
    server.use(defaultChatHandler);
    const model = makeModel();
    let text = "";
    for await (const part of model.stream([{ role: "user", content: "hi" }])) {
      if (part.type === "text-delta") text += part.text;
    }
    expect(text).toBe("Hello world");
  });

  it("stops emitting deltas and yields a single finish(aborted) when aborted partway through a stream", async () => {
    const encoder = new TextEncoder();
    server.use(
      http.post(`${FAKE_BASE_URL}/chat/completions`, () => {
        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            send({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "one " }, finish_reason: null }] });
            await new Promise((r) => setTimeout(r, 20));
            send({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "two " }, finish_reason: null }] });
            await new Promise((r) => setTimeout(r, 200));
            send({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "three" }, finish_reason: "stop" }] });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
      }),
    );

    const model = makeModel();
    const controller = new AbortController();
    const parts = [];
    for await (const part of model.stream([{ role: "user", content: "hi" }], { signal: controller.signal })) {
      parts.push(part);
      if (part.type === "text-delta") {
        controller.abort();
      }
    }
    const finishes = parts.filter((p) => p.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ type: "finish", finishReason: "aborted" });
  });

  it("maps an upstream 429 to a retryable rate_limit AiError", async () => {
    server.use(
      http.post(`${FAKE_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ error: { message: "slow down" } }, { status: 429 }),
      ),
    );
    const model = makeModel();
    const error = await model.complete([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
    expect(isAiError(error)).toBe(true);
    if (isAiError(error)) {
      expect(error.code).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    }
  });

  it("maps an upstream 401 to a non-retryable auth AiError", async () => {
    server.use(
      http.post(`${FAKE_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ error: { message: "bad key" } }, { status: 401 }),
      ),
    );
    const model = makeModel();
    const error = await model.complete([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
    expect(isAiError(error)).toBe(true);
    if (isAiError(error)) {
      expect(error.code).toBe("auth");
      expect(error.retryable).toBe(false);
    }
  });

  it("throws invalid_response when the provider returns no choices", async () => {
    server.use(
      http.post(`${FAKE_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ id: "x", object: "chat.completion", created: 0, model: "fake-model", choices: [] }),
      ),
    );
    const model = makeModel();
    const error = await model.complete([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
    expect(isAiError(error)).toBe(true);
    if (isAiError(error)) {
      expect(error.code).toBe("invalid_response");
    }
  });
});
