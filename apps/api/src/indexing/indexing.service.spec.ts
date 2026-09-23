import { describe, expect, it, vi } from "vitest";
import type { EmbeddingModel } from "@kb/ai";
import type { Database } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiEnv } from "../config/env.js";
// IndexingQueue/IndexingRepository are type-only here — unlike
// indexing.service.ts itself, this file never goes through Nest's DI
// container (IndexingService is constructed directly, below), so there's
// no design:paramtypes concern (see D3.3) to keep these as value imports.
import type { IndexingQueue } from "./indexing.queue.js";
import type { ClaimedIndexingJob, IndexingRepository } from "./indexing.repository.js";
import { IndexingService } from "./indexing.service.js";

const JOB: ClaimedIndexingJob = { documentId: "doc-1", contentHash: "hash-1", attempts: 1 };

// Opaque as far as this test is concerned — every call IndexingService makes
// through it goes to the mocked IndexingRepository below, never a real
// Supabase client. Just needs to be a stable identity to pass through.
const FAKE_DB = {} as SupabaseClient<Database>;

const FAKE_ENV = {
  RAG_CHUNK_TOKENS: 450,
  RAG_CHUNK_MAX_TOKENS: 600,
  RAG_CHUNK_OVERLAP_TOKENS: 60,
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_PUBLISHABLE_KEY: "unused-in-this-test",
} as unknown as ApiEnv;

function makeEmbeddingModel(): EmbeddingModel {
  return {
    descriptor: { provider: "mock", model: "mock-embedding", baseUrl: "mock://local", dimensions: 4 },
    embed: vi.fn(async (inputs: string[]) => ({
      vectors: inputs.map(() => [0.1, 0.2, 0.3, 0.4]),
      usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5, estimated: true },
    })),
  };
}

function makeRepository(overrides: Partial<Record<keyof IndexingRepository, unknown>> = {}): IndexingRepository {
  return {
    findForIndexing: vi.fn(async () => ({
      id: "doc-1",
      title: "T",
      content: "Some real content that will chunk into at least one chunk just fine.",
      contentHash: "hash-1",
    })),
    markIndexing: vi.fn(async () => undefined),
    replaceChunks: vi.fn(async () => true),
    markFailed: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    completeJob: vi.fn(async () => undefined),
    failJob: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as IndexingRepository;
}

function makeQueue(): IndexingQueue {
  return { setProcessor: vi.fn(), kick: vi.fn() } as unknown as IndexingQueue;
}

/**
 * Regression tests for a bug found during Phase 4 re-validation: recording
 * the ai_usage_events row used to happen INSIDE the same try block as, and
 * BEFORE, the actual chunk write — so a transient failure in that purely
 * observational insert discarded an otherwise fully successful embed pass
 * and marked the document 'failed' without ever even attempting
 * replace_document_chunks. See docs/DECISIONS.md Phase 4.
 */
describe("IndexingService.process — usage recording must never affect the write path", () => {
  it("a recordUsage() failure does NOT stop chunks from being written, and does NOT mark the document failed", async () => {
    const repository = makeRepository({
      recordUsage: vi.fn(async () => {
        throw new Error("transient network blip writing ai_usage_events");
      }),
    });
    const service = new IndexingService(FAKE_ENV, makeEmbeddingModel(), makeQueue(), repository);

    await service.process(FAKE_DB, JOB);

    expect(repository.replaceChunks).toHaveBeenCalledTimes(1);
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.completeJob).toHaveBeenCalledTimes(1);
  });

  it("records usage AFTER replaceChunks, not before", async () => {
    const order: string[] = [];
    const repository = makeRepository({
      replaceChunks: vi.fn(async () => {
        order.push("replaceChunks");
        return true;
      }),
      recordUsage: vi.fn(async () => {
        order.push("recordUsage");
      }),
    });
    const service = new IndexingService(FAKE_ENV, makeEmbeddingModel(), makeQueue(), repository);

    await service.process(FAKE_DB, JOB);

    expect(order).toEqual(["replaceChunks", "recordUsage"]);
  });

  it("still records usage even when replaceChunks skips as stale (the embed() call already happened and already cost tokens)", async () => {
    const repository = makeRepository({ replaceChunks: vi.fn(async () => false) });
    const service = new IndexingService(FAKE_ENV, makeEmbeddingModel(), makeQueue(), repository);

    await service.process(FAKE_DB, JOB);

    expect(repository.recordUsage).toHaveBeenCalledTimes(1);
    expect(repository.markFailed).not.toHaveBeenCalled();
    // completeJob is still called (content_hash-guarded, so it's a safe
    // no-op against the DB in the real superseded case) — see
    // indexing.service.ts's own comment on why.
    expect(repository.completeJob).toHaveBeenCalledTimes(1);
  });

  it("a genuine embed() failure still marks the document failed (recordUsage is never reached), and marks the job row failed too", async () => {
    const repository = makeRepository();
    const failingEmbeddingModel: EmbeddingModel = {
      descriptor: { provider: "mock", model: "mock-embedding", baseUrl: "mock://local", dimensions: 4 },
      embed: vi.fn(async () => {
        throw new Error("provider outage");
      }),
    };
    const service = new IndexingService(FAKE_ENV, failingEmbeddingModel, makeQueue(), repository);

    await service.process(FAKE_DB, JOB);

    expect(repository.replaceChunks).not.toHaveBeenCalled();
    expect(repository.recordUsage).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledTimes(1);
    expect(repository.failJob).toHaveBeenCalledTimes(1);
    expect(repository.completeJob).not.toHaveBeenCalled();
  });

  it("a job whose content_hash no longer matches the document's (superseded before processing started) does nothing — no write, no completion, no failure", async () => {
    const repository = makeRepository({
      findForIndexing: vi.fn(async () => ({
        id: "doc-1",
        title: "T",
        content: "content",
        contentHash: "a-newer-hash", // differs from JOB.contentHash
      })),
    });
    const service = new IndexingService(FAKE_ENV, makeEmbeddingModel(), makeQueue(), repository);

    await service.process(FAKE_DB, JOB);

    expect(repository.markIndexing).not.toHaveBeenCalled();
    expect(repository.replaceChunks).not.toHaveBeenCalled();
    expect(repository.completeJob).not.toHaveBeenCalled();
    expect(repository.failJob).not.toHaveBeenCalled();
  });
});
