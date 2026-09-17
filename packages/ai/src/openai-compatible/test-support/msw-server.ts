import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

/**
 * Shared MSW handlers/server for stubbing an OpenAI-compatible API in tests.
 * Not a *.spec.ts file, so vitest's `include` glob won't try to run it as a
 * test suite on its own — it's imported by the spec files that need it.
 */

export const FAKE_BASE_URL = "https://fake-provider.test/v1";

interface ChatCompletionRequestBody {
  model: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  max_tokens?: number;
  messages: Array<{ role: string; content: string }>;
}

interface EmbeddingRequestBody {
  model: string;
  input: string | string[];
  dimensions?: number;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const defaultChatHandler = http.post(`${FAKE_BASE_URL}/chat/completions`, async ({ request }) => {
  const body = (await request.json()) as ChatCompletionRequestBody;

  if (!body.stream) {
    return HttpResponse.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }

  const includeUsage = body.stream_options?.include_usage === true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        ),
      );
      if (includeUsage) {
        controller.enqueue(
          encoder.encode(
            sseChunk({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }),
          ),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new HttpResponse(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});

export const defaultEmbeddingHandler = http.post(`${FAKE_BASE_URL}/embeddings`, async ({ request }) => {
  const body = (await request.json()) as EmbeddingRequestBody;
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const dimensions = body.dimensions ?? 1536;

  return HttpResponse.json({
    object: "list",
    model: body.model,
    data: inputs.map((_input, index) => ({
      object: "embedding" as const,
      index,
      embedding: new Array(dimensions).fill(0).map((_, i) => (i === index % dimensions ? 1 : 0)),
    })),
    usage: { prompt_tokens: inputs.length * 3, total_tokens: inputs.length * 3 },
  });
});

export const server = setupServer(defaultChatHandler, defaultEmbeddingHandler);
