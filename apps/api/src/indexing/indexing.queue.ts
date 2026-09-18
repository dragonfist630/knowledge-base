import { Injectable, Logger } from "@nestjs/common";
import PQueue from "p-queue";

export interface IndexingJob {
  documentId: string;
  contentHash: string;
  userJwt: string;
}

export type IndexingProcessor = (job: IndexingJob) => Promise<void>;

/**
 * In-process, concurrency-limited job queue for the chunk -> embed ->
 * replace_document_chunks pipeline (IndexingService, Phase 4). Two
 * invariants, both load-bearing:
 *
 * 1. Concurrency 2 globally (via p-queue) — at most two documents are ever
 *    being indexed at the same time, so a burst of saves doesn't hammer
 *    the embedding provider or the DB.
 * 2. Per-document serialization with "latest job wins": a document ID
 *    occupies exactly one p-queue slot for the ENTIRE time it has work
 *    pending, not one slot per enqueue. A second `enqueue()` for a
 *    document that's already running doesn't start a second task — it
 *    just replaces `pendingByDocument.get(documentId)`, and the running
 *    task loops to pick that newer job up once its current pass finishes.
 *    An in-flight embed/DB call is never cancelled (that's not something
 *    you can safely do to a network call mid-flight); instead, a stale
 *    job for the same document simply never gets its own processor run,
 *    because by the time the loop checks again, `pendingByDocument` only
 *    remembers the newest one. `replace_document_chunks`'s own
 *    content_hash guard (see supabase/migrations) is the second, belt-and-
 *    suspenders layer against a slow stale write clobbering a newer one.
 *
 * The processor itself is late-bound via `setProcessor()` rather than
 * constructor-injected, to avoid a circular DI dependency: IndexingService
 * needs this queue injected (to register itself as the processor), and
 * this queue would need IndexingService injected to call it — Nest can't
 * construct either first. `setProcessor()` is called from
 * IndexingService's constructor instead, which runs after both classes
 * exist. See docs/DECISIONS.md Phase 4.
 */
@Injectable()
export class IndexingQueue {
  private readonly logger = new Logger(IndexingQueue.name);
  private readonly queue = new PQueue({ concurrency: 2 });
  private readonly pendingByDocument = new Map<string, IndexingJob>();
  private readonly active = new Set<string>();
  private processor: IndexingProcessor | undefined;

  /** Late-bound by IndexingService's constructor — see the class docstring. */
  setProcessor(processor: IndexingProcessor): void {
    this.processor = processor;
  }

  enqueue(job: IndexingJob): void {
    this.pendingByDocument.set(job.documentId, job);
    if (this.active.has(job.documentId)) {
      // A p-queue task for this document is already running (or scheduled)
      // and will pick up this newer job when its loop checks again.
      return;
    }
    this.active.add(job.documentId);
    void this.queue.add(() => this.runForDocument(job.documentId));
  }

  private async runForDocument(documentId: string): Promise<void> {
    try {
      for (;;) {
        const job = this.pendingByDocument.get(documentId);
        this.pendingByDocument.delete(documentId);
        if (!job) break;

        if (!this.processor) {
          this.logger.warn(`No processor registered yet — dropping indexing job for document ${documentId}.`);
          break;
        }

        try {
          await this.processor(job);
        } catch (error) {
          // The processor (IndexingService) is responsible for recording a
          // failure against the document itself (index_status='failed' +
          // index_error). This catch is only a backstop so a bug in that
          // error handling can't take down the whole queue's event loop.
          this.logger.error(
            `Indexing job for document ${documentId} threw an unhandled error.`,
            error instanceof Error ? error.stack : error,
          );
        }
      }
    } finally {
      this.active.delete(documentId);
    }
  }

  /** True while a job for this document currently holds a queue slot (running, or about to). Test/inspection hook. */
  isActive(documentId: string): boolean {
    return this.active.has(documentId);
  }

  /** Resolves once every currently queued/running job has settled. Test/inspection hook. */
  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }
}
