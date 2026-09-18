import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { AiError, MockEmbeddingModel } from "@kb/ai";
import type { CallOptions, EmbeddingModel, TokenUsage } from "@kb/ai";
import { chunkDocument } from "@kb/rag-core";
import request from "supertest";

import { EMBEDDING_MODEL } from "../src/ai/ai.module.js";
import { AppModule } from "../src/app.module.js";
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
});
