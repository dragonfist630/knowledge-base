import { createHash } from "node:crypto";

import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { DocumentCreate, DocumentDetail, DocumentListQuery, DocumentUpdate } from "@kb/shared";

import type { AuthContext } from "../auth/auth-request.js";
// IndexingQueue and DocumentsRepository must stay value imports
// (constructor-injected) — see docs/DECISIONS.md Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { IndexingQueue } from "../indexing/indexing.queue.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DocumentsRepository, type ListDocumentsResult } from "./documents.repository.js";

/**
 * The embedding input is `${headingPath}\n\n${chunk.content}` and
 * headingPath starts with the document title (see packages/rag-core,
 * Phase 4) — so a title change is a content change for hashing purposes.
 * Tags never feed the embeddings, so they're deliberately excluded: a
 * tags-only edit must not change this hash (see documents.service.spec.ts).
 */
export function computeContentHash(title: string, content: string): string {
  return createHash("sha256").update(title).update("\0").update(content).digest("hex");
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly repository: DocumentsRepository,
    private readonly indexingQueue: IndexingQueue,
  ) {}

  async list(auth: AuthContext, query: DocumentListQuery): Promise<ListDocumentsResult> {
    await this.resumeStuckIndexing(auth);
    return this.repository.list(auth.db, query);
  }

  async getById(auth: AuthContext, id: string): Promise<DocumentDetail> {
    await this.resumeStuckIndexing(auth);
    const document = await this.repository.findById(auth.db, id);
    if (!document) {
      throw new NotFoundException("Document not found.");
    }
    return document;
  }

  /**
   * Crash recovery for IndexingQueue, which is in-process and in-memory
   * (see indexing.queue.ts's docstring): if the API restarts while a
   * document is 'pending' or 'indexing', that job is gone and nothing will
   * ever pick it back up on its own.
   *
   * A boot-time sweep can't fix this by itself: RLS means any query only
   * ever sees ONE user's documents under THAT user's JWT, and at boot
   * there is no user's JWT to run it with — the only way around that would
   * be a service-role client, which this app deliberately has nowhere
   * (see docs/DECISIONS.md; D3.6 exists specifically because a forged
   * service-role token is dangerous). So instead of a boot-time sweep,
   * this runs lazily, scoped to whichever user is making a request right
   * now, using THEIR OWN already-verified JWT — which never sees, and
   * never needs to see, any other user's documents.
   *
   * Re-enqueuing a document that's already actively processing in this
   * same process is a safe, cheap no-op (IndexingQueue.isActive), so this
   * is fine to call on every list()/getById(). See docs/DECISIONS.md Phase
   * 4 for the full trade-off writeup, including the one residual gap this
   * leaves: a document whose owner never makes another request stays
   * stuck until they do.
   */
  private async resumeStuckIndexing(auth: AuthContext): Promise<void> {
    let stuck: { id: string; content_hash: string }[];
    try {
      stuck = await this.repository.findStuckIndexing(auth.db);
    } catch {
      // Best-effort only — a sweep failure must never break a normal read.
      return;
    }
    for (const doc of stuck) {
      if (this.indexingQueue.isActive(doc.id)) continue;
      this.indexingQueue.enqueue({ documentId: doc.id, contentHash: doc.content_hash, userJwt: auth.jwt });
    }
  }

  async create(auth: AuthContext, input: DocumentCreate): Promise<DocumentDetail> {
    const contentHash = computeContentHash(input.title, input.content);
    const document = await this.repository.insert(auth.db, {
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      content_hash: contentHash,
    });
    this.indexingQueue.enqueue({ documentId: document.id, contentHash, userJwt: auth.jwt });
    return document;
  }

  /**
   * `input.expectedUpdatedAt`, when the client sends it, is the
   * `updatedAt` of the document version the edit was made against (see
   * DocumentDetail/DocumentSummary — every read already carries it, so
   * this needs no separate "give me a version token" round trip). Passed
   * through to the repository's conditional update: a 0-hashChanged
   * (tags-only) edit races just as easily as a content edit, so this
   * check applies unconditionally, not only when hashChanged.
   *
   * Without this, two overlapping edits of the same document (two tabs,
   * or a background reindex retry racing a manual edit) would silently
   * resolve last-write-wins — the loser's edit vanishes with no error and
   * no trace, since both requests read the SAME starting `existing` and
   * neither ever sees the other's write. See docs/DECISIONS.md D9.12.
   */
  async update(auth: AuthContext, id: string, input: DocumentUpdate): Promise<DocumentDetail> {
    const existing = await this.repository.findHashById(auth.db, id);
    if (!existing) {
      throw new NotFoundException("Document not found.");
    }

    const nextTitle = input.title ?? existing.title;
    const nextContent = input.content ?? existing.content;
    const nextTags = input.tags ?? existing.tags;
    const nextHash = computeContentHash(nextTitle, nextContent);
    const hashChanged = nextHash !== existing.content_hash;

    const updated = await this.repository.update(
      auth.db,
      id,
      {
        title: nextTitle,
        content: nextContent,
        tags: nextTags,
        ...(hashChanged
          ? { content_hash: nextHash, index_status: "pending" as const, index_error: null }
          : {}),
      },
      input.expectedUpdatedAt,
    );
    if (updated === "conflict") {
      throw new ConflictException("This document was changed elsewhere since you last loaded it. Refresh and try again.");
    }
    if (!updated) {
      throw new NotFoundException("Document not found.");
    }

    if (hashChanged) {
      this.indexingQueue.enqueue({ documentId: id, contentHash: nextHash, userJwt: auth.jwt });
    }
    return updated;
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const deleted = await this.repository.delete(auth.db, id);
    if (!deleted) {
      throw new NotFoundException("Document not found.");
    }
  }

  async reindex(auth: AuthContext, id: string): Promise<DocumentDetail> {
    const existing = await this.repository.findHashById(auth.db, id);
    if (!existing) {
      throw new NotFoundException("Document not found.");
    }
    if (existing.index_status !== "failed") {
      throw new ConflictException("Only a document in a failed index state can be reindexed.");
    }

    // No expectedUpdatedAt here, so repository.update can only ever
    // return a real DocumentDetail or null (never "conflict" — that
    // outcome is only possible when a version check was actually
    // requested, see documents.repository.ts's update()). The `=== null`
    // check (rather than `!updated`) exists purely so the "conflict"
    // branch stays visibly unreachable to the type checker, not because
    // it can happen in practice.
    const updated = await this.repository.update(auth.db, id, {
      index_status: "pending",
      index_error: null,
    });
    if (updated === null || updated === "conflict") {
      throw new NotFoundException("Document not found.");
    }

    this.indexingQueue.enqueue({ documentId: id, contentHash: existing.content_hash, userJwt: auth.jwt });
    return updated;
  }
}
