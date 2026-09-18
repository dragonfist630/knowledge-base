import { describe, expect, it, vi } from "vitest";
import type { ChatModel, ChatStreamPart, FinishReason } from "@kb/ai";
import { AiError } from "@kb/ai";
import type { ChatEvent, Message } from "@kb/shared";

import type { ApiEnv } from "../config/env.js";
// UsageRepository/RetrievalService are type-only here — like
// retrieval.service.spec.ts, this file constructs ChatService directly
// rather than through Nest's DI container, so there's no design:paramtypes
// concern (see D3.3) to keep these as value imports.
import type { UsageRepository } from "../common/usage.repository.js";
import type { RetrievalService, RetrieveResult, Source } from "../retrieval/retrieval.service.js";
import { ChatService } from "./chat.service.js";
import type { ConversationsRepository } from "./conversations.repository.js";

const FAKE_ENV = { RAG_HISTORY_TOKENS: 1500 } as unknown as ApiEnv;
const FAKE_DB = {} as never;

function makeStream(parts: ChatStreamPart[]): ChatModel["stream"] {
  return vi.fn(async function* () {
    for (const part of parts) yield part;
  });
}

function makeChatModel(overrides: Partial<ChatModel> = {}): ChatModel {
  return {
    descriptor: { provider: "mock", model: "mock-chat", baseUrl: "mock://local" },
    complete: vi.fn(),
    stream: makeStream([{ type: "text-delta", text: "The answer is 5 days [S1]." }, { type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false } }]),
    ...overrides,
  } as ChatModel;
}

function source(overrides: Partial<Source> = {}): Source {
  return {
    sourceId: "S1",
    chunkIds: ["c0"],
    documentId: "11111111-1111-1111-1111-111111111111",
    documentTitle: "Doc One",
    headingPath: "Doc One > Intro",
    content: "Refunds are processed within 5 business days.",
    charStart: 0,
    charEnd: 45,
    similarity: 0.8,
    score: 0.7,
    ...overrides,
  };
}

function retrieveResult(overrides: Partial<RetrieveResult> = {}): RetrieveResult {
  return { sources: [source()], rewrittenQuery: "refund window", usedRewrite: false, ...overrides };
}

function makeRetrievalService(overrides: Partial<Record<keyof RetrievalService, unknown>> = {}): RetrievalService {
  return { retrieve: vi.fn(async () => retrieveResult()), ...overrides } as unknown as RetrievalService;
}

function makeUsageRepository(overrides: Partial<Record<keyof UsageRepository, unknown>> = {}): UsageRepository {
  return { recordUsage: vi.fn(async () => undefined), ...overrides } as unknown as UsageRepository;
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    role: "assistant",
    content: "",
    status: "streaming",
    citations: [],
    retrieval: null,
    model: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface RepoState {
  conversationId: string;
  messages: Message[];
}

function makeRepository(
  state: Partial<RepoState> = {},
  overrides: Partial<Record<keyof ConversationsRepository, unknown>> = {},
): ConversationsRepository {
  const conversationId = state.conversationId ?? "22222222-2222-2222-2222-222222222222";
  let nextMessageId = 1;
  return {
    findById: vi.fn(async (_db: unknown, id: string) =>
      id === conversationId
        ? { id: conversationId, title: "Existing conversation", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
        : null,
    ),
    create: vi.fn(async (_db: unknown, title: string) => ({
      id: conversationId,
      title,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    rename: vi.fn(async () => null),
    delete: vi.fn(async () => true),
    touch: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => state.messages ?? []),
    insertUserMessage: vi.fn(async (_db: unknown, _cid: string, content: string) =>
      message({ id: `user-${nextMessageId++}`, role: "user", content, status: "complete" }),
    ),
    insertAssistantPlaceholder: vi.fn(async () => message({ id: `assistant-${nextMessageId++}`, role: "assistant" })),
    finalizeAssistantMessage: vi.fn(async (_db: unknown, id: string, values: Record<string, unknown>) =>
      message({ id, role: "assistant", ...values } as Partial<Message>),
    ),
    ...overrides,
  } as unknown as ConversationsRepository;
}

function makeService(opts: {
  chatModel?: ChatModel;
  repository?: ConversationsRepository;
  retrievalService?: RetrievalService;
  usageRepository?: UsageRepository;
} = {}): ChatService {
  return new ChatService(
    FAKE_ENV,
    opts.chatModel ?? makeChatModel(),
    opts.repository ?? makeRepository(),
    opts.retrievalService ?? makeRetrievalService(),
    opts.usageRepository ?? makeUsageRepository(),
  );
}

function collectEvents(): { emit: (event: ChatEvent) => void; events: ChatEvent[] } {
  const events: ChatEvent[] = [];
  return { emit: (event) => events.push(event), events };
}

describe("ChatService.runTurn — happy path", () => {
  it("emits start -> sources -> delta -> citation -> done, in that order", async () => {
    const service = makeService();
    const { emit, events } = collectEvents();

    await service.runTurn(FAKE_DB, { message: "What's the refund window?" }, { onEvent: emit });

    expect(events.map((e) => e.type)).toEqual(["start", "sources", "delta", "citation", "done"]);
  });

  it("persists the assistant message as complete, with the cited source snapshotted", async () => {
    const repository = makeRepository();
    const service = makeService({ repository });

    const result = await service.runTurn(FAKE_DB, { message: "What's the refund window?" });

    expect(result.assistantMessage.status).toBe("complete");
    expect(result.assistantMessage.content).toBe("The answer is 5 days [S1].");
    expect(repository.finalizeAssistantMessage).toHaveBeenCalledWith(
      FAKE_DB,
      expect.any(String),
      expect.objectContaining({
        status: "complete",
        citations: [expect.objectContaining({ sourceId: "S1", documentId: source().documentId })],
      }),
    );
  });

  it("records a chat usage event and touches the conversation", async () => {
    const repository = makeRepository();
    const usageRepository = makeUsageRepository();
    const service = makeService({ repository, usageRepository });

    await service.runTurn(FAKE_DB, { message: "hi" });

    expect(usageRepository.recordUsage).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({ operation: "chat", totalTokens: 15 }),
    );
    expect(repository.touch).toHaveBeenCalled();
  });

  it("does not cite a source id the model hallucinates (not in the retrieved set)", async () => {
    const chatModel = makeChatModel({
      stream: makeStream([
        { type: "text-delta", text: "See [S1] and [S9]." },
        { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false } },
      ]),
    });
    const service = makeService({ chatModel });
    const { emit, events } = collectEvents();

    await service.runTurn(FAKE_DB, { message: "hi" }, { onEvent: emit });

    const citationEvents = events.filter((e) => e.type === "citation");
    expect(citationEvents).toEqual([{ type: "citation", sourceId: "S1" }]);
    const doneIndex = events.findIndex((e) => e.type === "delta" && e.text.includes("[S9]"));
    expect(doneIndex).toBe(-1); // the invalid marker is stripped from the emitted text entirely
  });
});

describe("ChatService.runTurn — no retrieved context", () => {
  it("returns the fixed NO_CONTEXT_MESSAGE and records no chat usage event", async () => {
    const retrievalService = makeRetrievalService({ retrieve: vi.fn(async () => retrieveResult({ sources: [] })) });
    const usageRepository = makeUsageRepository();
    const chatModel = makeChatModel();
    const service = makeService({ retrievalService, usageRepository, chatModel });
    const { emit, events } = collectEvents();

    const result = await service.runTurn(FAKE_DB, { message: "something not in any document" }, { onEvent: emit });

    expect(result.assistantMessage.content).toContain("couldn't find this in your documents");
    expect(result.assistantMessage.status).toBe("complete");
    expect(chatModel.stream).not.toHaveBeenCalled();
    expect(usageRepository.recordUsage).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(["start", "sources", "delta", "done"]);
  });
});

describe("ChatService.runTurn — conversation lookup", () => {
  it("throws NotFoundException for an unknown conversationId, before inserting any message", async () => {
    const repository = makeRepository();
    const service = makeService({ repository });

    await expect(
      service.runTurn(FAKE_DB, { conversationId: "99999999-9999-9999-9999-999999999999", message: "hi" }),
    ).rejects.toThrow(/not found/i);
    expect(repository.insertUserMessage).not.toHaveBeenCalled();
  });

  it("reuses an existing conversation instead of creating a new one", async () => {
    const conversationId = "22222222-2222-2222-2222-222222222222";
    const repository = makeRepository({ conversationId });
    const service = makeService({ repository });

    const result = await service.runTurn(FAKE_DB, { conversationId, message: "follow-up" });

    expect(result.conversationId).toBe(conversationId);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("creates a new conversation, titled from the first message, when no conversationId is given", async () => {
    const repository = makeRepository();
    const service = makeService({ repository });

    await service.runTurn(FAKE_DB, { message: "What is the refund policy for enterprise customers?" });

    expect(repository.create).toHaveBeenCalledWith(FAKE_DB, "What is the refund policy for enterprise customers?");
  });
});

describe("ChatService.runTurn — error paths", () => {
  it("persists status 'error' and emits an error event when retrieval throws, without recording chat usage", async () => {
    const retrievalService = makeRetrievalService({ retrieve: vi.fn(async () => { throw new AiError("unavailable", "provider down"); }) });
    const repository = makeRepository();
    const usageRepository = makeUsageRepository();
    const service = makeService({ retrievalService, repository, usageRepository });
    const { emit, events } = collectEvents();

    const result = await service.runTurn(FAKE_DB, { message: "hi" }, { onEvent: emit });

    expect(result.assistantMessage.status).toBe("error");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "ai_unavailable" });
    expect(usageRepository.recordUsage).not.toHaveBeenCalled();
    // An errored turn still counts as activity — the conversation's
    // updated_at must still advance, same as the success and no-context
    // paths (found during Phase 5 re-validation; previously this path
    // skipped touch() entirely, so an errored conversation never sorted
    // as recently active).
    expect(repository.touch).toHaveBeenCalledWith(FAKE_DB, result.conversationId);
  });

  it("persists whatever partial text streamed before a mid-stream failure, with citations already seen", async () => {
    const chatModel = makeChatModel({
      stream: vi.fn(async function* () {
        yield { type: "text-delta", text: "Partial answer [S1]. " } satisfies ChatStreamPart;
        throw new Error("connection reset");
      }),
    });
    const repository = makeRepository();
    const service = makeService({ chatModel, repository });
    const { emit, events } = collectEvents();

    const result = await service.runTurn(FAKE_DB, { message: "hi" }, { onEvent: emit });

    expect(result.assistantMessage.status).toBe("error");
    expect(repository.finalizeAssistantMessage).toHaveBeenCalledWith(
      FAKE_DB,
      expect.any(String),
      expect.objectContaining({
        content: "Partial answer [S1]. ",
        status: "error",
        citations: [expect.objectContaining({ sourceId: "S1" })],
      }),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect(repository.touch).toHaveBeenCalledWith(FAKE_DB, result.conversationId);
  });

  it("uses a generic message for a non-AiError failure, never leaking the raw error", async () => {
    const retrievalService = makeRetrievalService({ retrieve: vi.fn(async () => { throw new Error("pgbouncer: connection refused"); }) });
    const service = makeService({ retrievalService });
    const { emit, events } = collectEvents();

    await service.runTurn(FAKE_DB, { message: "hi" }, { onEvent: emit });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ code: "internal_error" });
    expect(errorEvent && "message" in errorEvent ? errorEvent.message : "").not.toContain("pgbouncer");
  });
});

describe("ChatService.runTurn — abort", () => {
  it("persists status 'aborted' and emits done with finishReason 'aborted' when the model stream ends aborted", async () => {
    const chatModel = makeChatModel({
      stream: makeStream([
        { type: "text-delta", text: "Partial" },
        { type: "finish", finishReason: "aborted" as FinishReason, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: true } },
      ]),
    });
    const repository = makeRepository();
    const service = makeService({ chatModel, repository });
    const { emit, events } = collectEvents();

    const result = await service.runTurn(FAKE_DB, { message: "hi" }, { onEvent: emit });

    expect(result.assistantMessage.status).toBe("aborted");
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "aborted" });
  });
});

describe("ChatService — history loading", () => {
  it("reuses complete and aborted assistant turns as history but drops error/streaming ones", async () => {
    const conversationId = "22222222-2222-2222-2222-222222222222";
    const repository = makeRepository({
      conversationId,
      messages: [
        message({ id: "m1", role: "user", content: "first question", status: "complete" }),
        message({ id: "m2", role: "assistant", content: "first answer", status: "complete" }),
        message({ id: "m3", role: "user", content: "second question", status: "complete" }),
        message({ id: "m4", role: "assistant", content: "aborted answer", status: "aborted" }),
        message({ id: "m5", role: "user", content: "third question", status: "complete" }),
        message({ id: "m6", role: "assistant", content: "", status: "error" }),
        message({ id: "m7", role: "user", content: "fourth question", status: "complete" }),
        message({ id: "m8", role: "assistant", content: "", status: "streaming" }),
      ],
    });
    const chatModel = makeChatModel();
    const service = makeService({ chatModel, repository });

    await service.runTurn(FAKE_DB, { conversationId, message: "fifth question" });

    const streamCall = (chatModel.stream as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!streamCall) throw new Error("expected chatModel.stream to have been called");
    const messages = streamCall[0] as { role: string; content: string }[];
    const contents = messages.map((m) => m.content);
    expect(contents).toEqual(expect.arrayContaining(["first question", "first answer", "second question", "aborted answer", "third question", "fourth question"]));
    expect(contents.join(" ")).not.toContain("error");
  });
});

describe("ChatService — conversation CRUD", () => {
  it("getConversation returns the conversation with its messages, oldest first", async () => {
    const conversationId = "22222222-2222-2222-2222-222222222222";
    const repository = makeRepository({ conversationId, messages: [message({ id: "m1" })] });
    const service = makeService({ repository });

    const detail = await service.getConversation(FAKE_DB, conversationId);

    expect(detail.id).toBe(conversationId);
    expect(detail.messages).toHaveLength(1);
  });

  it("getConversation throws NotFoundException for a missing conversation", async () => {
    const repository = makeRepository();
    const service = makeService({ repository });

    await expect(service.getConversation(FAKE_DB, "99999999-9999-9999-9999-999999999999")).rejects.toThrow(/not found/i);
  });

  it("deleteConversation throws NotFoundException when nothing was deleted", async () => {
    const repository = makeRepository({}, { delete: vi.fn(async () => false) });
    const service = makeService({ repository });

    await expect(service.deleteConversation(FAKE_DB, "99999999-9999-9999-9999-999999999999")).rejects.toThrow(/not found/i);
  });
});
