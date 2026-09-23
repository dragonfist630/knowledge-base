import { Injectable } from "@nestjs/common";
import type { Database } from "@kb/shared";
import type { DocumentDetail, DocumentSummary } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

type DocumentRow = Database["public"]["Tables"]["documents"]["Row"];

type SummaryColumn =
  | "id"
  | "title"
  | "tags"
  | "source_type"
  | "source_name"
  | "index_status"
  | "index_error"
  | "chunk_count"
  | "indexed_at"
  | "created_at"
  | "updated_at";

// Kept as a plain string LITERAL (not built via Array.join()) on purpose:
// supabase-js's typed `.select()` only statically parses a select string
// into a narrowed row type when it's a literal type, not a runtime
// `string` — a computed value degrades to its `GenericStringError` escape
// hatch instead. SummaryColumn above is the single source of truth this
// literal is kept in sync with; toSummary/toDetail's `Pick<...>` params are
// what actually get typechecked against it.
const SUMMARY_COLUMNS_STR =
  "id, title, tags, source_type, source_name, index_status, index_error, chunk_count, indexed_at, created_at, updated_at";
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS_STR}, content`;

export interface ListDocumentsParams {
  q?: string;
  tag?: string;
  cursor?: string;
  limit: number;
}

export interface ListDocumentsResult {
  items: DocumentSummary[];
  nextCursor: string | null;
}

/** Escapes ilike's own wildcard characters so a literal `%`/`_` in a search term isn't treated as a pattern. */
function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

function toSummary(row: Pick<DocumentRow, SummaryColumn>): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    tags: row.tags,
    sourceType: row.source_type as DocumentSummary["sourceType"],
    sourceName: row.source_name,
    indexStatus: row.index_status,
    indexError: row.index_error,
    chunkCount: row.chunk_count,
    indexedAt: row.indexed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDetail(row: Pick<DocumentRow, SummaryColumn | "content">): DocumentDetail {
  return { ...toSummary(row), content: row.content };
}

/**
 * Thin wrapper over the Supabase client — no business logic here (that's
 * documents.service.ts). Every method takes the caller's request-scoped
 * client, so every query it runs is evaluated under RLS as that user; there
 * is no user_id filter here because RLS already enforces it (a stray filter
 * here would be redundant, not a safety net — see docs/DECISIONS.md).
 */
@Injectable()
export class DocumentsRepository {
  async list(db: SupabaseClient<Database>, params: ListDocumentsParams): Promise<ListDocumentsResult> {
    let query = db
      .from("documents")
      .select(SUMMARY_COLUMNS_STR)
      .order("updated_at", { ascending: false })
      .limit(params.limit + 1);

    if (params.q) {
      query = query.ilike("title", `%${escapeIlike(params.q)}%`);
    }
    if (params.tag) {
      query = query.contains("tags", [params.tag]);
    }
    if (params.cursor) {
      query = query.lt("updated_at", params.cursor);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data ?? [];
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? (page.at(-1)?.updated_at ?? null) : null;

    return { items: page.map(toSummary), nextCursor };
  }

  async findById(db: SupabaseClient<Database>, id: string): Promise<DocumentDetail | null> {
    const { data, error } = await db.from("documents").select(DETAIL_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? toDetail(data) : null;
  }

  /** Just the columns the service needs to decide whether content_hash changed (and, for reindex, the current status) — avoids fetching `content` twice. */
  async findHashById(
    db: SupabaseClient<Database>,
    id: string,
  ): Promise<Pick<DocumentRow, "id" | "title" | "content" | "tags" | "content_hash" | "index_status"> | null> {
    const { data, error } = await db
      .from("documents")
      .select("id, title, content, tags, content_hash, index_status")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  /**
   * This caller's own documents currently sitting in 'pending' or
   * 'indexing' — used for the crash-recovery sweep (documents.service.ts's
   * resumeStuckIndexing / see docs/DECISIONS.md Phase 4). RLS means this
   * can only ever return the requesting user's own rows, same as every
   * other method here.
   */
  async findStuckIndexing(db: SupabaseClient<Database>): Promise<Pick<DocumentRow, "id" | "content_hash">[]> {
    const { data, error } = await db.from("documents").select("id, content_hash").in("index_status", ["pending", "indexing"]);
    if (error) throw error;
    return data ?? [];
  }

  async insert(
    db: SupabaseClient<Database>,
    values: Pick<Database["public"]["Tables"]["documents"]["Insert"], "title" | "content" | "tags" | "content_hash">,
  ): Promise<DocumentDetail> {
    const { data, error } = await db
      .from("documents")
      .insert({ ...values, index_status: "pending" })
      .select(DETAIL_COLUMNS)
      .single();
    if (error) throw error;
    return toDetail(data);
  }

  /**
   * `expectedUpdatedAt`, when given, makes this an optimistic-concurrency
   * write: the update's own WHERE clause requires `updated_at` to still
   * match what the caller last read, so a save that raced another one
   * (same document, both started from the same snapshot) can never
   * silently clobber the other — see documents.service.ts's update() and
   * docs/DECISIONS.md D9.12. `updated_at` is trigger-maintained
   * (set_documents_updated_at, supabase/migrations) and already returned
   * to every client via DocumentDetail/DocumentSummary, so this needs no
   * new column.
   *
   * A conditional update affecting 0 rows is ambiguous by itself — the id
   * might not exist at all, or it might exist with a DIFFERENT
   * updated_at (i.e. someone else's write already landed). Only in that
   * ambiguous case (and only then — the common paths take one round
   * trip, same as before) this runs one extra existence check to tell
   * the two apart, and returns the literal `"conflict"` for the second
   * one so the caller can map it to 409 rather than a misleading 404.
   */
  async update(
    db: SupabaseClient<Database>,
    id: string,
    values: Database["public"]["Tables"]["documents"]["Update"],
    expectedUpdatedAt?: string,
  ): Promise<DocumentDetail | null | "conflict"> {
    let query = db.from("documents").update(values).eq("id", id);
    if (expectedUpdatedAt !== undefined) {
      query = query.eq("updated_at", expectedUpdatedAt);
    }
    const { data, error } = await query.select(DETAIL_COLUMNS).maybeSingle();
    if (error) throw error;
    if (data) return toDetail(data);
    if (expectedUpdatedAt === undefined) return null;

    const stillExists = await db.from("documents").select("id").eq("id", id).maybeSingle();
    if (stillExists.error) throw stillExists.error;
    return stillExists.data ? "conflict" : null;
  }

  async delete(db: SupabaseClient<Database>, id: string): Promise<boolean> {
    const { data, error } = await db.from("documents").delete().eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    return data !== null;
  }
}
