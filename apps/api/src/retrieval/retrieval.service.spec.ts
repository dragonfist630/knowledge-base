import { describe, expect, it, vi } from "vitest";
import type { ChatCompletion, ChatModel, EmbeddingModel } from "@kb/ai";
import { chunkDocument } from "@kb/rag-core";
import type { HistoryTurn } from "@kb/rag-core";

import type { ApiEnv } from "../config/env.js";
// UsageRepository/RetrievalRepository are type-only here — like
// indexing.service.spec.ts, this file constructs RetrievalService directly
// rather than through Nest's DI container, so there's no design:paramtypes
// concern (see D3.3) to keep these as value imports.
import type { UsageRepository } from "../common/usage.repository.js";
import type { MatchedChunk } from "./retrieval.repository.js";
import type { RetrievalRepository } from "./retrieval.repository.js";
import { RetrievalService } from "./retrieval.service.js";

const FAKE_ENV = {
  RAG_TOP_K: 8,
  RAG_MIN_SIMILARITY: 0.25,
  RAG_CONTEXT_TOKENS: 3500,
  RAG_HISTORY_TOKENS: 1500,
  RAG_QUERY_REWRITE: true,
  RAG_QUERY_REWRITE_TIMEOUT_MS: 5000,
} as unknown as ApiEnv;

const FAKE_DB = {} as never;

function makeChatModel(overrides: Partial<ChatModel> = {}): ChatModel {
  return {
    descriptor: { provider: "mock", model: "mock-chat", baseUrl: "mock://local" },
    complete: vi.fn(async (): Promise<ChatCompletion> => ({
      text: "rewritten standalone query",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: true },
      finishReason: "stop",
    })),
    stream: vi.fn(),
    ...overrides,
  } as ChatModel;
}

function makeEmbeddingModel(): EmbeddingModel {
  return {
    descriptor: { provider: "mock", model: "mock-embedding", baseUrl: "mock://local", dimensions: 4 },
    embed: vi.fn(async (inputs: string[]) => ({
      vectors: inputs.map(() => [0.1, 0.2, 0.3, 0.4]),
      usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5, estimated: true },
    })),
  };
}

function chunk(overrides: Partial<MatchedChunk> = {}): MatchedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    documentTitle: "Doc One",
    chunkIndex: 0,
    headingPath: "Doc One > Intro",
    content: "Some chunk content.",
    charStart: 0,
    charEnd: 20,
    similarity: 0.8,
    textRank: 0,
    score: 0.5,
    ...overrides,
  };
}

function makeRepository(rows: MatchedChunk[], overrides: Partial<Record<keyof RetrievalRepository, unknown>> = {}): RetrievalRepository {
  return {
    matchDocumentChunks: vi.fn(async () => rows),
    findContentByIds: vi.fn(async () => new Map<string, string>()),
    ...overrides,
  } as unknown as RetrievalRepository;
}

function makeUsageRepository(overrides: Partial<Record<keyof UsageRepository, unknown>> = {}): UsageRepository {
  return { recordUsage: vi.fn(async () => undefined), ...overrides } as unknown as UsageRepository;
}

describe("RetrievalService — query rewrite", () => {
  it("does not rewrite when there is no history", async () => {
    const chatModel = makeChatModel();
    const repository = makeRepository([]);
    const service = new RetrievalService(FAKE_ENV, chatModel, makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "What is the refund policy?", history: [] }, "conv-1");

    expect(chatModel.complete).not.toHaveBeenCalled();
    expect(result.usedRewrite).toBe(false);
    expect(result.rewrittenQuery).toBe("What is the refund policy?");
  });

  it("does not rewrite when RAG_QUERY_REWRITE is disabled, even with history", async () => {
    const chatModel = makeChatModel();
    const env = { ...FAKE_ENV, RAG_QUERY_REWRITE: false } as unknown as ApiEnv;
    const service = new RetrievalService(env, chatModel, makeEmbeddingModel(), makeRepository([]), makeUsageRepository());
    const history: HistoryTurn[] = [{ role: "user", content: "hi" }];

    const result = await service.retrieve(FAKE_DB, { question: "and them?", history }, "conv-1");

    expect(chatModel.complete).not.toHaveBeenCalled();
    expect(result.usedRewrite).toBe(false);
  });

  it("rewrites when there is history, and records a query_rewrite usage event", async () => {
    const chatModel = makeChatModel();
    const usageRepository = makeUsageRepository();
    const service = new RetrievalService(FAKE_ENV, chatModel, makeEmbeddingModel(), makeRepository([]), usageRepository);
    const history: HistoryTurn[] = [
      { role: "user", content: "What's the refund window?" },
      { role: "assistant", content: "5 business days [S1]." },
    ];

    const result = await service.retrieve(FAKE_DB, { question: "What about enterprise?", history }, "conv-1");

    expect(chatModel.complete).toHaveBeenCalledTimes(1);
    expect(result.usedRewrite).toBe(true);
    expect(result.rewrittenQuery).toBe("rewritten standalone query");
    expect(usageRepository.recordUsage).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({ operation: "query_rewrite", conversationId: "conv-1" }),
    );
  });

  it("strips citation markers from assistant history before sending it to the rewrite call", async () => {
    const chatModel = makeChatModel();
    const service = new RetrievalService(FAKE_ENV, chatModel, makeEmbeddingModel(), makeRepository([]), makeUsageRepository());
    const history: HistoryTurn[] = [{ role: "assistant", content: "The window is 5 days [S1][S2]." }];

    await service.retrieve(FAKE_DB, { question: "and refunds over $100?", history }, "conv-1");

    const call = (chatModel.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!call) throw new Error("expected chatModel.complete to have been called");
    const messages = call[0] as { role: string; content: string }[];
    const assistantTurn = messages.find((m) => m.content.includes("The window is 5 days"));
    expect(assistantTurn?.content).toBe("The window is 5 days.");
  });

  it("falls back to the raw question when the rewrite call throws", async () => {
    const chatModel = makeChatModel({ complete: vi.fn(async () => { throw new Error("provider outage"); }) });
    const usageRepository = makeUsageRepository();
    const service = new RetrievalService(FAKE_ENV, chatModel, makeEmbeddingModel(), makeRepository([]), usageRepository);
    const history: HistoryTurn[] = [{ role: "user", content: "hi" }];

    const result = await service.retrieve(FAKE_DB, { question: "the real question", history }, "conv-1");

    expect(result.usedRewrite).toBe(false);
    expect(result.rewrittenQuery).toBe("the real question");
    expect(usageRepository.recordUsage).not.toHaveBeenCalled();
  });

  it("falls back to the raw question when the rewrite call returns an empty string", async () => {
    const chatModel = makeChatModel({
      complete: vi.fn(async (): Promise<ChatCompletion> => ({
        text: "   ",
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1, estimated: true },
        finishReason: "stop",
      })),
    });
    const service = new RetrievalService(FAKE_ENV, chatModel, makeEmbeddingModel(), makeRepository([]), makeUsageRepository());
    const history: HistoryTurn[] = [{ role: "user", content: "hi" }];

    const result = await service.retrieve(FAKE_DB, { question: "the real question", history }, "conv-1");

    expect(result.usedRewrite).toBe(false);
    expect(result.rewrittenQuery).toBe("the real question");
  });
});

describe("RetrievalService — embedding + RPC call shape", () => {
  it("embeds the effective query and passes a pgvector text-literal to the RPC", async () => {
    const embeddingModel = makeEmbeddingModel();
    const repository = makeRepository([]);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), embeddingModel, repository, makeUsageRepository());

    await service.retrieve(FAKE_DB, { question: "hello", history: [] }, "conv-1");

    expect(embeddingModel.embed).toHaveBeenCalledWith(["hello"]);
    expect(repository.matchDocumentChunks).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({
        queryEmbedding: "[0.1,0.2,0.3,0.4]",
        queryText: "hello",
        matchCount: FAKE_ENV.RAG_TOP_K,
        minSimilarity: FAKE_ENV.RAG_MIN_SIMILARITY,
      }),
    );
  });

  it("passes documentIds/tags filters through to the RPC", async () => {
    const repository = makeRepository([]);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    await service.retrieve(FAKE_DB, { question: "hi", history: [], documentIds: ["doc-1"], tags: ["a"] }, "conv-1");

    expect(repository.matchDocumentChunks).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({ filterDocumentIds: ["doc-1"], filterTags: ["a"] }),
    );
  });
});

describe("RetrievalService — near-duplicate (overlap-adjacent) merging", () => {
  it("merges consecutive chunk_index rows from the same document into one source with combined offsets", async () => {
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "c0", chunkIndex: 0, charStart: 0, charEnd: 100, content: "chunk 0 (unused post-merge)", score: 0.9 }),
      chunk({ chunkId: "c1", chunkIndex: 1, charStart: 70, charEnd: 180, content: "chunk 1 (unused post-merge)", score: 0.7 }),
    ];
    const fullDocument = "x".repeat(180);
    const repository = makeRepository(rows, {
      findContentByIds: vi.fn(async () => new Map([["doc-1", fullDocument]])),
    });
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      sourceId: "S1",
      chunkIds: ["c0", "c1"],
      charStart: 0,
      charEnd: 180,
    });
    expect(result.sources[0]?.content).toBe(fullDocument.slice(0, 180));
  });

  it("does NOT merge chunks from the same document with a gap in chunk_index", async () => {
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "c0", chunkIndex: 0, score: 0.9 }),
      chunk({ chunkId: "c5", chunkIndex: 5, score: 0.7 }),
    ];
    const repository = makeRepository(rows);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((s) => s.chunkIds)).toEqual([["c0"], ["c5"]]);
  });

  it("does NOT merge adjacent-index chunks from DIFFERENT documents", async () => {
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "a0", documentId: "doc-a", chunkIndex: 0, score: 0.9 }),
      chunk({ chunkId: "b0", documentId: "doc-b", chunkIndex: 0, score: 0.7 }),
    ];
    const repository = makeRepository(rows);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources).toHaveLength(2);
  });

  it("does NOT merge adjacent-index chunks from the SAME document that have different heading_path", async () => {
    // D5.10: consecutive chunk_index alone isn't enough — the chunker
    // never applies overlap across a heading boundary and never includes
    // heading lines in chunk content, so two chunks from different
    // sections share no text even when index-adjacent. Merging them used
    // to report the wrong (first chunk's) heading_path and splice the
    // second section's own heading markup into the re-sliced content.
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "c0", chunkIndex: 0, headingPath: "Doc One > Section A", content: "Section A content.", score: 0.9 }),
      chunk({ chunkId: "c1", chunkIndex: 1, headingPath: "Doc One > Section B", content: "Section B content.", score: 0.7 }),
    ];
    const repository = makeRepository(rows);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((s) => s.chunkIds)).toEqual([["c0"], ["c1"]]);
    expect(result.sources.map((s) => s.headingPath)).toEqual(["Doc One > Section A", "Doc One > Section B"]);
    // Never re-fetches/re-slices document content for chunks that didn't merge.
    expect(repository.findContentByIds).toHaveBeenCalledWith(FAKE_DB, []);
  });

  it("real chunker output: adjacent chunks from different sections stay separate, with no leaked heading markup", async () => {
    // End-to-end regression for D5.10, against the actual chunker rather
    // than synthetic fixtures — reproduces the exact failure mode the
    // independent re-validation found.
    const title = "My Doc";
    const content = "## Section A\n\nThis is the content of section A. It talks about apples.\n\n## Section B\n\nThis is the content of section B. It talks about oranges.\n";
    const chunks = chunkDocument(title, content, { targetTokens: 20, maxTokens: 40, overlapTokens: 5, minTrailingTokens: 3 });
    const a = chunks.find((c) => c.headingPath?.includes("Section A"));
    const b = chunks.find((c) => c.headingPath?.includes("Section B"));
    if (!a || !b) throw new Error("expected the fixture document to produce one chunk per section");
    expect(b.chunkIndex).toBe(a.chunkIndex + 1); // genuinely index-adjacent

    const rows: MatchedChunk[] = [
      chunk({ chunkId: "chunk-a", documentId: "doc-1", documentTitle: title, chunkIndex: a.chunkIndex, headingPath: a.headingPath, content: a.content, charStart: a.charStart, charEnd: a.charEnd, score: 0.9 }),
      chunk({ chunkId: "chunk-b", documentId: "doc-1", documentTitle: title, chunkIndex: b.chunkIndex, headingPath: b.headingPath, content: b.content, charStart: b.charStart, charEnd: b.charEnd, score: 0.85 }),
    ];
    const repository = makeRepository(rows, { findContentByIds: vi.fn(async () => new Map([["doc-1", content]])) });
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources).toHaveLength(2);
    const sourceA = result.sources.find((s) => s.headingPath?.includes("Section A"));
    const sourceB = result.sources.find((s) => s.headingPath?.includes("Section B"));
    expect(sourceA?.content).not.toContain("#");
    expect(sourceB?.content).not.toContain("#");
    expect(sourceA?.headingPath).toBe(a.headingPath);
    expect(sourceB?.headingPath).toBe(b.headingPath);
  });

  it("does not re-fetch document content for single-chunk (unmerged) sources", async () => {
    const rows: MatchedChunk[] = [chunk({ chunkId: "c0", chunkIndex: 0, content: "original chunk content" })];
    const repository = makeRepository(rows);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(repository.findContentByIds).toHaveBeenCalledWith(FAKE_DB, []);
    expect(result.sources[0]?.content).toBe("original chunk content");
  });
});

describe("RetrievalService — context token budget", () => {
  it("stops including sources once RAG_CONTEXT_TOKENS is exceeded", async () => {
    const bigContent = "word ".repeat(2000); // well over budget on its own
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "c0", documentId: "doc-1", chunkIndex: 0, content: bigContent, score: 0.9 }),
      chunk({ chunkId: "c1", documentId: "doc-2", chunkIndex: 0, content: "a short second source", score: 0.8 }),
    ];
    const env = { ...FAKE_ENV, RAG_CONTEXT_TOKENS: 100 } as unknown as ApiEnv;
    const repository = makeRepository(rows);
    const service = new RetrievalService(env, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    // Always keeps at least the first (highest-scoring) source even though
    // it alone blows the budget — never ends up with zero context just
    // because the single best match happens to be huge.
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.chunkIds).toEqual(["c0"]);
  });

  it("keeps multiple sources that together fit the budget", async () => {
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "c0", documentId: "doc-1", chunkIndex: 0, content: "short one", score: 0.9 }),
      chunk({ chunkId: "c1", documentId: "doc-2", chunkIndex: 0, content: "short two", score: 0.8 }),
    ];
    const repository = makeRepository(rows);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((s) => s.sourceId)).toEqual(["S1", "S2"]);
  });

  it("assigns sourceIds sequentially in final (post-budget, score-sorted) order", async () => {
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "low", documentId: "doc-low", chunkIndex: 0, content: "low score", score: 0.1 }),
      chunk({ chunkId: "high", documentId: "doc-high", chunkIndex: 0, content: "high score", score: 0.9 }),
    ];
    const repository = makeRepository(rows);
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources[0]).toMatchObject({ sourceId: "S1", chunkIds: ["high"] });
    expect(result.sources[1]).toMatchObject({ sourceId: "S2", chunkIds: ["low"] });
  });

  it("returns zero sources when the RPC finds nothing", async () => {
    const service = new RetrievalService(FAKE_ENV, makeChatModel(), makeEmbeddingModel(), makeRepository([]), makeUsageRepository());
    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");
    expect(result.sources).toEqual([]);
  });

  it("skips a mid-ranked block that doesn't fit the remaining budget, but still packs a smaller, lower-ranked block after it", async () => {
    // Found during Phase 5 re-validation: the packing loop used to `break`
    // as soon as any block failed to fit, so block B (too big) wrongly
    // knocked out block C too, even though C alone would have fit fine in
    // the budget left after A. It should `continue` past B instead.
    const rows: MatchedChunk[] = [
      chunk({ chunkId: "a", documentId: "doc-a", chunkIndex: 0, content: "word ".repeat(10), score: 0.9 }), // fits
      chunk({ chunkId: "b", documentId: "doc-b", chunkIndex: 0, content: "word ".repeat(40), score: 0.8 }), // too big, must be skipped
      chunk({ chunkId: "c", documentId: "doc-c", chunkIndex: 0, content: "word ".repeat(5), score: 0.7 }), // small enough to still fit
    ];
    const env = { ...FAKE_ENV, RAG_CONTEXT_TOKENS: 30 } as unknown as ApiEnv;
    const repository = makeRepository(rows);
    const service = new RetrievalService(env, makeChatModel(), makeEmbeddingModel(), repository, makeUsageRepository());

    const result = await service.retrieve(FAKE_DB, { question: "q", history: [] }, "conv-1");

    expect(result.sources.map((s) => s.chunkIds[0])).toEqual(["a", "c"]);
  });
});
