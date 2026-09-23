import { Inject, Injectable, Logger } from "@nestjs/common";
import PQueue from "p-queue";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@kb/shared";

import { createUserScopedClient } from "../auth/supabase-client.factory.js";
import { API_ENV } from "../config/config.module.js";
import type { ApiEnv } from "../config/env.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { IndexingRepository, type ClaimedIndexingJob } from "./indexing.repository.js";

export interface IndexingJob {
  documentId: string;
  contentHash: string;
  userJwt: string;
}

export type IndexingProcessor = (db: SupabaseClient<Database>, job: ClaimedIndexingJob) => Promise<void>;

/**
 * D9.14 (Phase 9): a durable indexing queue, replacing the Phase 4
 * in-memory `p-queue` this class used to wrap directly. See
 * docs/DECISIONS.md D9.14 for the full writeup and
 * supabase/migrations/*_document_indexing_jobs.sql for the table/RPC this
 * is built on.
 *
 * The durable state (which documents have a pending/processing/failed job)
 * now lives in `document_indexing_jobs`, not in this class — a restart no
 * longer silently drops queued work. What this class still does, exactly
 * like before, is bound how much indexing work THIS process does
 * concurrently (`localQueue`, concurrency 2, same limit as Phase 4).
 *
 * There is deliberately no generic, timer-driven background poller here.
 * Every Postgres access in this app runs as some real user's own,
 * already-verified JWT (RLS is the only authorization boundary — no
 * service-role client anywhere, D3.6), and a poller with no request behind
 * it has no such JWT to run as. So claiming only ever happens
 * request-adjacent: right after `enqueue()` (using the JWT that request
 * just authenticated with), and via `documents.service.ts`'s
 * `resumeStuckIndexing` sweep, which calls `kick()` directly with the
 * current request's own live `auth.db` — using whatever later request
 * happens to trigger it, always with a fresh, currently-valid JWT, never a
 * stored one (there isn't one — see the migration's own comment on why
 * this table holds no credential column). A document whose owner never
 * makes another request after a crash stays stuck until they do; this is
 * the same residual gap the old in-memory queue's crash-recovery sweep
 * already had, not a new one — see docs/SCALING.md item 1.
 */
@Injectable()
export class IndexingQueue {
  private readonly logger = new Logger(IndexingQueue.name);
  private readonly localQueue = new PQueue({ concurrency: 2 });
  // A job stuck in 'processing' longer than this (its owning process
  // crashed or was killed mid-job) becomes claimable again by anyone's next
  // sweep. 5 minutes is generous relative to AI_REQUEST_TIMEOUT_MS's own
  // default (60s) and AI_MAX_RETRIES — a genuinely still-running job should
  // never look stale under normal operation.
  private static readonly STALE_AFTER_SECONDS = 5 * 60;
  private processor: IndexingProcessor | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly repository: IndexingRepository,
  ) {}

  setProcessor(processor: IndexingProcessor): void {
    this.processor = processor;
  }

  /**
   * Durably upserts the job (see `IndexingRepository.enqueueJob`), then
   * best-effort kicks off an immediate local claim+process attempt using a
   * client scoped to the JWT this call was given — never awaited by
   * callers (documents.service.ts calls this fire-and-forget, same
   * contract as the old in-memory version), so a failure anywhere in here
   * must never surface as a request failure. The durable row is the safety
   * net: if this kick never runs (or the process dies mid-job), the row
   * sits as 'pending'/stale-'processing' until some later request's
   * `kick()` (via resumeStuckIndexing, or another enqueue for the same
   * document) claims it.
   */
  enqueue(job: IndexingJob): void {
    void this.enqueueAndKick(job);
  }

  private async enqueueAndKick(job: IndexingJob): Promise<void> {
    const db = createUserScopedClient(this.env, job.userJwt);
    try {
      await this.repository.enqueueJob(db, { documentId: job.documentId, contentHash: job.contentHash });
    } catch (error) {
      this.logger.error(`Failed to persist indexing job for document ${job.documentId}.`, error instanceof Error ? error.stack : error);
      return;
    }
    this.kick(db);
  }

  /**
   * Opportunistically claims and runs up to `count` of the CALLING
   * client's own pending/stale jobs, bounded by this process's local
   * concurrency limiter (each is its own independent claim + local queue
   * slot, so `count` above the queue's own concurrency just queues the
   * rest behind whatever's already running). `db` must already be scoped
   * to a real, live, already-verified user JWT — `enqueue()` passes a
   * client built from the JWT that just authenticated the write;
   * `documents.service.ts`'s `resumeStuckIndexing` passes the current
   * request's own `auth.db` directly, with a larger `count` to sweep for
   * more than one stuck document per call. Safe to call speculatively: a
   * claim that finds nothing (everything already claimed by another
   * replica/request, or genuinely idle) is a cheap no-op, and `for update
   * skip locked` means concurrent callers — including two calls from this
   * same method — never block each other or double-claim the same row.
   */
  kick(db: SupabaseClient<Database>, count = 1): void {
    for (let i = 0; i < count; i++) {
      void this.localQueue.add(() => this.claimAndProcessOne(db));
    }
  }

  private async claimAndProcessOne(db: SupabaseClient<Database>): Promise<void> {
    let claimed: ClaimedIndexingJob[];
    try {
      claimed = await this.repository.claimJobs(db, 1, IndexingQueue.STALE_AFTER_SECONDS);
    } catch (error) {
      this.logger.error("Failed to claim an indexing job.", error instanceof Error ? error.stack : error);
      return;
    }
    const job = claimed[0];
    if (!job) return;
    if (!this.processor) {
      this.logger.warn(`No processor registered yet — leaving claimed job for document ${job.documentId} as 'processing' for a later sweep to reclaim.`);
      return;
    }
    try {
      await this.processor(db, job);
    } catch (error) {
      // The processor (IndexingService) is responsible for recording a
      // failure against both documents.index_status and this job row. This
      // catch is only a backstop so a bug in that error handling can't
      // take down the whole local queue's event loop.
      this.logger.error(`Indexing job for document ${job.documentId} threw an unhandled error.`, error instanceof Error ? error.stack : error);
    } finally {
      // A newer edit to this same document may have upserted a fresh
      // 'pending' job while this one was processing (documents.service's
      // update() enqueues unconditionally on a hash change). Try to claim
      // again immediately, with this same still-valid client — this is
      // what gives "latest job wins" its low-latency behavior in practice,
      // the same way the old in-memory queue's inner loop picked up a
      // newer `pendingByDocument` entry before releasing its p-queue slot.
      // A claim that finds nothing pending is a cheap, terminating no-op,
      // not an actual loop.
      this.kick(db);
    }
  }

  /** Resolves once every currently queued/running local job has settled. Test/inspection hook. */
  async onIdle(): Promise<void> {
    await this.localQueue.onIdle();
  }
}
