import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { AiError, MockEmbeddingModel } from "@kb/ai";
import type { CallOptions, EmbeddingModel, TokenUsage } from "@kb/ai";
import { chunkDocument } from "@kb/rag-core";
import type { Database } from "@kb/shared";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";

import { EMBEDDING_MODEL } from "../src/ai/ai.module.js";
import { AppModule } from "../src/app.module.js";
import { computeContentHash } from "../src/documents/documents.service.js";
import { waitFor } from "./e2e/wait-for.js";

/** Any embed() input containing this string simulates a provider outage — see ControllableEmbeddingModel below. */
const FAILURE_SENTINEL = "__FORCE_EMBEDDING_FAILURE_FOR_E2E__";

/**
 * Wraps the real MockEmbeddingModel so this suite can deterministically
 * force an embedding failure for one specific document without needing
 * any test-only hook in @kb/ai itself — everything else still goes
 * through the real, deterministic mock embedder.
 */
class ControllableEmbeddingModel implements EmbeddingModel {
  readonly descriptor: EmbeddingModel["descriptor"];
  private readonly delegate = new MockEmbeddingModel();

  constructor() {
    this.descriptor = this.delegate.descriptor;
  }

  async embed(inputs: string[], opts?: CallOptions): Promise<{ vectors: number[][]; usage: TokenUsage }> {
    if (inputs.some((input) => input.includes(FAILURE_SENTINEL))) {
      throw new AiError("unavailable", "Simulated embedding provider outage (e2e test).", {
        provider: "mock-controllable",
      });
    }
    return this.delegate.embed(inputs, opts);
  }
}

/**
 * Gate 4 e2e — the real chunk -> embed -> replace_document_chunks pipeline
 * (Phase 4), against the same real Postgres+RLS+PostgREST stack as
 * documents.e2e-spec.ts (test/e2e/global-setup.ts). The embedding model is
 * overridden here (not the default mock straight from AiModule) so one
 * specific test can force a failure deterministically — see
 * ControllableEmbeddingModel above.
 */
describe("Indexing pipeline (e2e)", () => {
  let app: INestApplication;
  const { userA } = globalThis.__KB_E2E__;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMBEDDING_MODEL)
      .useValue(new ControllableEmbeddingModel())
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const authed = (jwt: string) => `Bearer ${jwt}`;

  // A raw client for asserting on tables the DTO doesn't expose (like
  // ai_usage_events) — built the exact same way apps/api's own
  // createUserScopedClient is (publishable key + this user's own JWT), so
  // this reads under the real RLS policy, not a privileged bypass.
  const userADb: SupabaseClient<Database> = createClient<Database>(
    globalThis.__KB_E2E__.SUPABASE_URL,
    "e2e-test-publishable-key",
    { global: { headers: { Authorization: authed(userA.jwt) } }, auth: { persistSession: false, autoRefreshToken: false } },
  );

  const getDoc = (id: string) =>
    request(app.getHttpServer())
      .get(`/documents/${id}`)
      .set("Authorization", authed(userA.jwt))
      .expect(200)
      .then((r) => r.body);

  it("creates a document that goes pending -> ready with chunk_count > 0, matching the chunker's own output", async () => {
    const title = "Gate 4 Basic Doc";
    const content = "A short paragraph about widgets. It has a couple of sentences in it.";

    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title, content })
      .expect(201);
    expect(createRes.body.indexStatus).toBe("pending");

    const ready = await waitFor(() => getDoc(createRes.body.id), (doc) => doc.indexStatus === "ready", {
      label: "basic doc index",
    });

    const expectedChunks = chunkDocument(title, content);
    expect(ready.chunkCount).toBe(expectedChunks.length);
    expect(ready.chunkCount).toBeGreaterThan(0);
    expect(ready.indexedAt).toBeTruthy();
    expect(ready.indexError).toBeNull();

    // ai_usage_events isn't on the DTO at all, so this is the only way to
    // prove the pipeline actually records the embedding call it made —
    // previously nothing asserted this happens at all.
    const { data: usageRows, error: usageError } = await userADb
      .from("ai_usage_events")
      .select("operation, provider, model, prompt_tokens, total_tokens, is_estimated, document_id")
      .eq("document_id", createRes.body.id);
    expect(usageError).toBeNull();
    expect(usageRows).toHaveLength(1);
    expect(usageRows?.[0]).toMatchObject({
      operation: "embedding",
      provider: "mock",
      document_id: createRes.body.id,
    });
    expect(usageRows?.[0]?.total_tokens).toBeGreaterThan(0);
    expect(usageRows?.[0]?.is_estimated).toBe(true);
  });

  it("updating content twice in quick succession ends ready with chunks matching the SECOND update", async () => {
    const title = "Gate 4 Race Doc";
    const longSentence = "This paragraph exists to make the first update noticeably longer than the second one. ";
    const initialContent = "Initial content for the race test.";
    const firstUpdate = longSentence.repeat(30); // several chunks
    const secondUpdate = "Short final version."; // exactly one chunk

    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title, content: initialContent })
      .expect(201);
    const docId: string = createRes.body.id;

    // Fire both updates back-to-back, without waiting for either to be
    // indexed — IndexingQueue's "latest job wins" per document ID is
    // exactly the mechanism under test here (see indexing.queue.ts).
    await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: firstUpdate })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: secondUpdate })
      .expect(200);

    const finalDoc = await waitFor(
      () => getDoc(docId),
      (doc) => doc.indexStatus === "ready" && doc.content === secondUpdate,
      { label: "race doc final state", timeoutMs: 8000 },
    );

    const expectedChunksForSecondUpdate = chunkDocument(title, secondUpdate);
    expect(finalDoc.chunkCount).toBe(expectedChunksForSecondUpdate.length);
    expect(finalDoc.chunkCount).toBe(1);
    expect(finalDoc.content).toBe(secondUpdate);
  });

  it("a forced embedding failure leaves the document 'failed' with its OLD chunks/count preserved", async () => {
    const originalContent = "The original, successfully indexed content for the failure test.";

    const createRes = await request(app.getHttpServer())
      .post("/documents")
      .set("Authorization", authed(userA.jwt))
      .send({ title: "Gate 4 Failure Doc", content: originalContent })
      .expect(201);
    const docId: string = createRes.body.id;

    const readyBefore = await waitFor(() => getDoc(docId), (doc) => doc.indexStatus === "ready", {
      label: "failure doc initial index",
    });
    expect(readyBefore.chunkCount).toBeGreaterThan(0);
    const chunkCountBeforeFailure = readyBefore.chunkCount;
    const indexedAtBeforeFailure = readyBefore.indexedAt;

    await request(app.getHttpServer())
      .patch(`/documents/${docId}`)
      .set("Authorization", authed(userA.jwt))
      .send({ content: `This update's embedding call will blow up. ${FAILURE_SENTINEL}` })
      .expect(200);

    const failed = await waitFor(() => getDoc(docId), (doc) => doc.indexStatus === "failed", {
      label: "failure doc after forced outage",
    });

    expect(failed.indexError).toBeTruthy();
    expect(typeof failed.indexError).toBe("string");
    // replace_document_chunks is never reached on an embed() failure, so
    // the OLD chunks (and the count/indexedAt that describe them) must be
    // completely untouched — a failed reindex must never lose what was
    // already successfully indexed.
    expect(failed.chunkCount).toBe(chunkCountBeforeFailure);
    expect(failed.indexedAt).toBe(indexedAtBeforeFailure);

    // And a document in 'failed' state IS eligible for the reindex endpoint
    // (unlike 'pending'/'ready'/'indexing' — see documents.e2e-spec.ts's
    // 409 test for the inverse of this).
    // NestJS's default @Post status is 201, not 200 — same as create.
    await request(app.getHttpServer())
      .post(`/documents/${docId}/reindex`)
      .set("Authorization", authed(userA.jwt))
      .expect(201);
  });

  /**
   * D9.14: the actual point of the persisted document_indexing_jobs table
   * (replacing the old in-memory IndexingQueue) is that a job survives
   * even when nothing local ever processes it. These two cases bypass
   * documents.service.ts's normal create()/enqueue() path entirely — using
   * userADb directly to insert a document and a document_indexing_jobs row
   * for it exactly the way an apps/api process's write WOULD have landed
   * a split second before that same process died, before its own local
   * kick() ever got to run — and then prove a la carte that a completely
   * unrelated later request (GET /documents/:id, which every read already
   * calls resumeStuckIndexing from) is what actually gets the document
   * indexed, with no direct call to anything indexing-specific.
   */
  it("a job left 'pending' with no local worker ever having run it still gets indexed by a later, unrelated request's crash-recovery sweep", async () => {
    const title = "Orphaned Pending Job Doc";
    const content = "This document's row was written directly, simulating a process that died right after committing its enqueue but before ever attempting to process it.";
    const contentHash = computeContentHash(title, content);

    const { data: doc, error: docError } = await userADb
      .from("documents")
      .insert({ title, content, content_hash: contentHash, index_status: "pending" })
      .select("id")
      .single();
    expect(docError).toBeNull();
    const docId = doc!.id;

    const { error: jobError } = await userADb
      .from("document_indexing_jobs")
      .insert({ document_id: docId, content_hash: contentHash });
    expect(jobError).toBeNull();

    // No enqueue(), no kick() — the ONLY thing that can possibly get this
    // document indexed from here is some later request's resumeStuckIndexing
    // sweep noticing the durable job row and claiming it.
    const ready = await waitFor(() => getDoc(docId), (d) => d.indexStatus === "ready", {
      label: "orphaned pending job doc",
    });
    expect(ready.chunkCount).toBeGreaterThan(0);

    const { data: jobRow } = await userADb.from("document_indexing_jobs").select("document_id").eq("document_id", docId).maybeSingle();
    expect(jobRow).toBeNull(); // completeJob deleted it once processed
  });

  it("a job stuck 'processing' past the staleness window (its claiming worker died mid-job) is reclaimed and completed by a later sweep", async () => {
    const title = "Stale Processing Job Doc";
    const content = "This document's job row was written directly as already-processing-but-ancient, simulating a worker that claimed it and then crashed mid-job.";
    const contentHash = computeContentHash(title, content);

    const { data: doc, error: docError } = await userADb
      .from("documents")
      .insert({ title, content, content_hash: contentHash, index_status: "indexing" })
      .select("id")
      .single();
    expect(docError).toBeNull();
    const docId = doc!.id;

    const staleLockedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago — well past the 5-minute staleness window
    const { error: jobError } = await userADb
      .from("document_indexing_jobs")
      .insert({ document_id: docId, content_hash: contentHash, status: "processing", locked_at: staleLockedAt, attempts: 1 });
    expect(jobError).toBeNull();

    const ready = await waitFor(() => getDoc(docId), (d) => d.indexStatus === "ready", {
      label: "stale processing job doc",
    });
    expect(ready.chunkCount).toBeGreaterThan(0);
  });
});
