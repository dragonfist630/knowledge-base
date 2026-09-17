import { Injectable, Logger } from "@nestjs/common";

export interface IndexingJob {
  documentId: string;
  contentHash: string;
  userJwt: string;
}

/**
 * Phase 3 owns the shape of this queue (documents.service enqueues into it
 * on create/update/reindex) but NOT its processing: the actual
 * chunk -> embed -> replace_document_chunks pipeline needs
 * packages/rag-core's chunker, which doesn't exist until Phase 4. This is a
 * deliberate phase boundary, not an oversight — see docs/DECISIONS.md Phase
 * 3 (D3.2). Until Phase 4 lands, a newly created/updated document sits in
 * index_status='pending' (set by documents.service itself, not by a
 * consumer here) and stays there; nothing in this class contacts an AI
 * provider or the database.
 *
 * The real Phase 4 implementation replaces this class's body (same public
 * `enqueue` signature — job carries { documentId, contentHash, userJwt } —
 * so documents.service doesn't change): an in-process p-queue keyed by
 * document ID, concurrency 2, latest-job-wins per document.
 */
@Injectable()
export class IndexingQueue {
  private readonly logger = new Logger(IndexingQueue.name);
  private readonly pending = new Map<string, IndexingJob>();

  enqueue(job: IndexingJob): void {
    this.pending.set(job.documentId, job);
    this.logger.debug(
      `Indexing queued for document ${job.documentId} (contentHash=${job.contentHash}) — no consumer yet, lands in Phase 4.`,
    );
  }

  /** Test/inspection hook only — the real Phase 4 queue won't need this. */
  peek(documentId: string): IndexingJob | undefined {
    return this.pending.get(documentId);
  }
}
