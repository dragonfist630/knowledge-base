import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { chunkDocument } from "@kb/rag-core";
import type { Chunk } from "@kb/rag-core";
import { isAiError } from "@kb/ai";
import type { EmbeddingModel } from "@kb/ai";
import type { Database } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createUserScopedClient } from "../auth/supabase-client.factory.js";
import { API_ENV } from "../config/config.module.js";
import type { ApiEnv } from "../config/env.js";
// IndexingQueue and IndexingRepository must stay value imports
// (constructor-injected) — see docs/DECISIONS.md Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { IndexingQueue, type IndexingJob } from "./indexing.queue.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { IndexingRepository, type RpcChunkInput } from "./indexing.repository.js";
// EMBEDDING_MODEL is a DI token (symbol), not a class — always a value.
import { EMBEDDING_MODEL } from "../ai/ai.module.js";

/**
 * The job processor for IndexingQueue: chunk -> embed -> atomically write
 * chunks. Registers itself with `queue.setProcessor()` in `onModuleInit`
 * rather than being constructor-injected INTO the queue, to avoid a
 * circular dependency — see indexing.queue.ts's docstring.
 *
 * Every step runs against a Supabase client scoped to the JOB'S OWN JWT
 * (captured by documents.service at enqueue time, not the JWT of whoever
 * happens to trigger processing), so indexing always runs under the same
 * RLS as the user who owns the document — there is still no service-role
 * client anywhere in this app.
 */
@Injectable()
export class IndexingService implements OnModuleInit {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(EMBEDDING_MODEL) private readonly embeddingModel: EmbeddingModel,
    private readonly queue: IndexingQueue,
    private readonly repository: IndexingRepository,
  ) {}

  onModuleInit(): void {
    this.queue.setProcessor((job) => this.process(job));
  }

  async process(job: IndexingJob): Promise<void> {
    const db = createUserScopedClient(this.env, job.userJwt);

    try {
      const document = await this.repository.findForIndexing(db, job.documentId);
      if (!document) {
        // Deleted (or no longer visible under this user's RLS) since this
        // job was enqueued — nothing left to index.
        return;
      }
      if (document.contentHash !== job.contentHash) {
        // A newer save has already superseded this job. Shouldn't normally
        // happen — IndexingQueue only ever keeps the latest job per
        // document — but staying a safe no-op if it ever does mirrors the
        // same guard replace_document_chunks applies at write time.
        return;
      }

      await this.repository.markIndexing(db, job.documentId, job.contentHash);

      const chunks = chunkDocument(document.title, document.content, {
        targetTokens: this.env.RAG_CHUNK_TOKENS,
        maxTokens: this.env.RAG_CHUNK_MAX_TOKENS,
        overlapTokens: this.env.RAG_CHUNK_OVERLAP_TOKENS,
      });

      const rpcChunks = chunks.length === 0 ? [] : await this.embedChunks(db, job, chunks);

      const wrote = await this.repository.replaceChunks(db, {
        documentId: job.documentId,
        contentHash: job.contentHash,
        embeddingModel: this.embeddingModel.descriptor.model,
        chunks: rpcChunks,
      });

      if (!wrote) {
        this.logger.debug(
          `Skipped writing chunks for document ${job.documentId} — a newer save already changed its content_hash.`,
        );
      }
    } catch (error) {
      await this.handleFailure(db, job, error);
    }
  }

  /** Embeds every chunk's input text and records the usage event. The embedding input is `${headingPath}\n\n${content}` — headingPath already starts with the document title (see @kb/rag-core's chunker), matching computeContentHash's own title-feeds-hashing rationale in documents.service.ts. */
  private async embedChunks(db: SupabaseClient<Database>, job: IndexingJob, chunks: Chunk[]): Promise<RpcChunkInput[]> {
    const inputs = chunks.map((chunk) => `${chunk.headingPath ?? ""}\n\n${chunk.content}`.trim());

    const startedAt = Date.now();
    const { vectors, usage } = await this.embeddingModel.embed(inputs);
    const latencyMs = Date.now() - startedAt;

    await this.repository.recordUsage(db, {
      operation: "embedding",
      provider: this.embeddingModel.descriptor.provider,
      model: this.embeddingModel.descriptor.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      isEstimated: usage.estimated,
      latencyMs,
      documentId: job.documentId,
    });

    return chunks.map((chunk, index) => ({
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      heading_path: chunk.headingPath,
      token_count: chunk.tokenCount,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      // pgvector's text input form; replace_document_chunks casts this with
      // `::extensions.vector` — see supabase/migrations/*_init.sql.
      embedding: `[${(vectors[index] ?? []).join(",")}]`,
    }));
  }

  private async handleFailure(db: SupabaseClient<Database>, job: IndexingJob, error: unknown): Promise<void> {
    this.logger.error(
      `Indexing failed for document ${job.documentId}.`,
      error instanceof Error ? error.stack : error,
    );

    // AiError's message is deliberately written to be safe to show a user
    // (see packages/ai/src/errors.ts); anything else (a DB error, a bug)
    // might not be, so it's logged above in full but replaced here with a
    // generic message before it reaches index_error, which IS user-facing
    // (documents.repository.ts exposes it on the DTO).
    const message = isAiError(error) ? error.message : "Indexing failed unexpectedly. Try reindexing.";

    try {
      await this.repository.markFailed(db, job.documentId, job.contentHash, message);
    } catch (markError) {
      this.logger.error(
        `Also failed to record the failure itself for document ${job.documentId}.`,
        markError instanceof Error ? markError.stack : markError,
      );
    }
  }
}
