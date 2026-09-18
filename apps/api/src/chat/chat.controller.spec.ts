import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatResponse, ConversationDetail, ConversationListResponse, ConversationSummary } from "@kb/shared";
import type { Response } from "express";

import type { AuthContext } from "../auth/auth-request.js";
import { ChatController } from "./chat.controller.js";
import type { ChatService, ChatTurnResult, RunTurnOptions } from "./chat.service.js";

const FAKE_AUTH: AuthContext = {
  userId: "user-1",
  email: "user@example.com",
  db: {} as never,
  jwt: "fake.jwt.token",
};

const CONVERSATION_ID = randomUUID();
const USER_MESSAGE_ID = randomUUID();
const ASSISTANT_MESSAGE_ID = randomUUID();

function makeChatTurnResult(overrides: Partial<ChatTurnResult> = {}): ChatTurnResult {
  return {
    conversationId: CONVERSATION_ID,
    userMessage: {
      id: USER_MESSAGE_ID,
      role: "user",
      content: "hi",
      status: "complete",
      citations: [],
      retrieval: null,
      model: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    assistantMessage: {
      id: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      content: "hello [S1]",
      status: "complete",
      citations: [],
      retrieval: null,
      model: "mock-chat",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sources: [],
    ...overrides,
  };
}

/**
 * Captures every res.write() call and the writeHead() args, without a real
 * socket — extends EventEmitter so `res.on("close", ...)` (see
 * chat.controller.ts's doc comment on why it's res, not req) works exactly
 * like a real http.ServerResponse for the abort test below.
 */
function makeFakeResponse(): Response & { writes: string[]; headStatus?: number; headHeaders?: Record<string, string>; ended: boolean } {
  const writes: string[] = [];
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    writes,
    ended: false,
    writeHead(status: number, headers: Record<string, string>) {
      res.headStatus = status;
      res.headHeaders = headers;
      return res;
    },
    flushHeaders: vi.fn(),
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
      return res;
    },
  }) as unknown as Response & { writes: string[]; headStatus?: number; headHeaders?: Record<string, string>; ended: boolean };
  return res;
}

function makeChatService(overrides: Partial<Record<keyof ChatService, unknown>> = {}): ChatService {
  return {
    runTurn: vi.fn(async (_db: unknown, _params: unknown, options?: RunTurnOptions) => {
      const events: ChatEvent[] = [
        {
          type: "start",
          conversationId: CONVERSATION_ID,
          userMessageId: USER_MESSAGE_ID,
          assistantMessageId: ASSISTANT_MESSAGE_ID,
        },
        { type: "sources", sources: [] },
        { type: "delta", text: "hello " },
        { type: "citation", sourceId: "S1" },
        { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false } },
      ];
      for (const event of events) options?.onEvent?.(event);
      return makeChatTurnResult();
    }),
    listConversations: vi.fn(async (): Promise<ConversationListResponse> => ({ items: [], nextCursor: null })),
    getConversation: vi.fn(async (): Promise<ConversationDetail> => ({
      id: "conv-1",
      title: "A conversation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [],
    })),
    renameConversation: vi.fn(async (): Promise<ConversationSummary> => ({
      id: "conv-1",
      title: "Renamed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    deleteConversation: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ChatService;
}

describe("ChatController.stream (SSE)", () => {
  it("writes the exact SSE headers before any event", async () => {
    const chatService = makeChatService();
    const controller = new ChatController(chatService);
    const res = makeFakeResponse();

    await controller.stream(FAKE_AUTH, { message: "hi" }, res);

    expect(res.headStatus).toBe(200);
    expect(res.headHeaders).toMatchObject({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
  });

  it("streams start -> sources -> delta -> citation -> done as `data: <json>\\n\\n` lines, in order, then ends the response", async () => {
    const chatService = makeChatService();
    const controller = new ChatController(chatService);
    const res = makeFakeResponse();

    await controller.stream(FAKE_AUTH, { message: "hi" }, res);

    const parsed = res.writes.filter((w) => w.startsWith("data: ")).map((w) => JSON.parse(w.slice("data: ".length, -2)) as ChatEvent);
    expect(parsed.map((e) => e.type)).toEqual(["start", "sources", "delta", "citation", "done"]);
    expect(res.ended).toBe(true);
  });

  it("passes an AbortSignal to runTurn that aborts when the underlying response closes", async () => {
    let capturedSignal: AbortSignal | undefined;
    let releaseRunTurn: () => void = () => undefined;
    const chatService = makeChatService({
      runTurn: vi.fn(async (_db: unknown, _params: unknown, options?: RunTurnOptions) => {
        capturedSignal = options?.signal;
        await new Promise<void>((resolve) => {
          releaseRunTurn = resolve;
        });
        return makeChatTurnResult();
      }),
    });
    const controller = new ChatController(chatService);
    const res = makeFakeResponse();

    const pending = controller.stream(FAKE_AUTH, { message: "hi" }, res);
    await Promise.resolve(); // let runTurn start and capture the signal
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(false);
    (res as unknown as EventEmitter).emit("close");
    expect(capturedSignal?.aborted).toBe(true);

    releaseRunTurn();
    await pending;
  });

  it("writes a single `error` event and ends the response when runTurn rejects before emitting anything", async () => {
    const chatService = makeChatService({
      runTurn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const controller = new ChatController(chatService);
    const res = makeFakeResponse();

    await controller.stream(FAKE_AUTH, { message: "hi" }, res);

    const parsed = res.writes.filter((w) => w.startsWith("data: ")).map((w) => JSON.parse(w.slice("data: ".length, -2)) as ChatEvent);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: "error", code: "chat_start_failed" });
    expect(res.ended).toBe(true);
  });

  it("sends a heartbeat comment every 15s while the turn is in flight, and stops once it finishes", async () => {
    vi.useFakeTimers();
    try {
      let releaseRunTurn: () => void = () => undefined;
      const chatService = makeChatService({
        runTurn: vi.fn(
          async () =>
            new Promise<ChatTurnResult>((resolve) => {
              releaseRunTurn = () => resolve(makeChatTurnResult());
            }),
        ),
      });
      const controller = new ChatController(chatService);
      const res = makeFakeResponse();

      const pending = controller.stream(FAKE_AUTH, { message: "hi" }, res);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(res.writes).toContain(": heartbeat\n\n");

      const heartbeatsBeforeFinish = res.writes.filter((w) => w === ": heartbeat\n\n").length;
      releaseRunTurn();
      await pending;

      await vi.advanceTimersByTimeAsync(30_000);
      const heartbeatsAfterFinish = res.writes.filter((w) => w === ": heartbeat\n\n").length;
      expect(heartbeatsAfterFinish).toBe(heartbeatsBeforeFinish);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ChatController.chat (non-streaming)", () => {
  it("returns the ChatResponse shape from ChatService.runTurn's result, without onEvent", async () => {
    const turnResult = makeChatTurnResult();
    const chatService = makeChatService({ runTurn: vi.fn(async () => turnResult) });
    const controller = new ChatController(chatService);

    const response: ChatResponse = await controller.chat(FAKE_AUTH, { message: "hi" });

    expect(response).toEqual({
      conversationId: turnResult.conversationId,
      userMessage: turnResult.userMessage,
      assistantMessage: turnResult.assistantMessage,
      sources: turnResult.sources,
    });
    expect(chatService.runTurn).toHaveBeenCalledWith(FAKE_AUTH.db, { message: "hi" });
  });
});

describe("ChatController — conversation CRUD passthroughs", () => {
  it("list() delegates to chatService.listConversations", async () => {
    const chatService = makeChatService();
    const controller = new ChatController(chatService);

    await controller.list(FAKE_AUTH, { limit: 20 });

    expect(chatService.listConversations).toHaveBeenCalledWith(FAKE_AUTH.db, { limit: 20 });
  });

  it("getById() delegates to chatService.getConversation", async () => {
    const chatService = makeChatService();
    const controller = new ChatController(chatService);

    await controller.getById(FAKE_AUTH, "conv-1");

    expect(chatService.getConversation).toHaveBeenCalledWith(FAKE_AUTH.db, "conv-1");
  });

  it("rename() delegates to chatService.renameConversation", async () => {
    const chatService = makeChatService();
    const controller = new ChatController(chatService);

    await controller.rename(FAKE_AUTH, "conv-1", { title: "New title" });

    expect(chatService.renameConversation).toHaveBeenCalledWith(FAKE_AUTH.db, "conv-1", "New title");
  });

  it("remove() delegates to chatService.deleteConversation", async () => {
    const chatService = makeChatService();
    const controller = new ChatController(chatService);

    await controller.remove(FAKE_AUTH, "conv-1");

    expect(chatService.deleteConversation).toHaveBeenCalledWith(FAKE_AUTH.db, "conv-1");
  });
});
