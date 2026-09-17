/**
 * Zod schemas for the documents feature — the one shared contract between
 * apps/web and apps/api. apps/api's ZodValidationPipe validates request
 * bodies/queries against these; apps/web infers its types from the same
 * schemas, so the two can never drift.
 *
 * Tags are normalized here (lowercase, deduped) rather than trusting the
 * client, since the same normalization has to happen wherever tags are
 * compared (filter_tags in match_document_chunks, the documents_tags_gin
 * index) — one normalization step, run once, on the way in.
 */

import { z } from "zod";

const TITLE_MAX = 200;
const CONTENT_MAX = 500_000;
const TAG_MAX = 32;
const TAGS_MAX = 20;

const trimmedTitle = z
  .string()
  .trim()
  .min(1, "title is required")
  .max(TITLE_MAX, `title must be ${TITLE_MAX} characters or fewer`);

const content = z.string().max(CONTENT_MAX, `content must be ${CONTENT_MAX} characters or fewer`);

const tag = z
  .string()
  .trim()
  .min(1, "tags cannot be empty strings")
  .max(TAG_MAX, `each tag must be ${TAG_MAX} characters or fewer`)
  .transform((value) => value.toLowerCase());

// No `.default([])` here on purpose: DocumentUpdateSchema's `.refine()`
// below needs to tell "tags omitted" (undefined) apart from "tags: []"
// (an explicit clear-all-tags edit) so an empty PATCH body still fails
// validation. Zod (v4) doesn't short-circuit `.optional()` around a
// `.default()`-bearing schema on `undefined` input — the default still
// fires — so `tagsWithoutDefault.optional()` is what actually yields
// `undefined` for an absent field; only DocumentCreateSchema, where
// "tags omitted" and "tags: []" should mean the same thing, applies
// `.default([])` on top.
const tagsWithoutDefault = z
  .array(tag)
  .max(TAGS_MAX, `at most ${TAGS_MAX} tags`)
  .transform((values) => Array.from(new Set(values)));

export const DocumentCreateSchema = z.object({
  title: trimmedTitle,
  content: content.default(""),
  tags: tagsWithoutDefault.default([]),
});
export type DocumentCreate = z.infer<typeof DocumentCreateSchema>;

export const DocumentUpdateSchema = z
  .object({
    title: trimmedTitle.optional(),
    content: content.optional(),
    tags: tagsWithoutDefault.optional(),
  })
  .refine((value) => value.title !== undefined || value.content !== undefined || value.tags !== undefined, {
    message: "at least one of title, content, or tags is required",
  });
export type DocumentUpdate = z.infer<typeof DocumentUpdateSchema>;

const paginationLimit = z.coerce.number().int().min(1).max(100).default(20);

export const DocumentListQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  tag: z
    .string()
    .trim()
    .min(1)
    .max(TAG_MAX)
    .transform((value) => value.toLowerCase())
    .optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: paginationLimit,
});
export type DocumentListQuery = z.infer<typeof DocumentListQuerySchema>;

/** Matches public.index_status in supabase/migrations. */
export const IndexStatusSchema = z.enum(["pending", "indexing", "ready", "failed"]);
export type IndexStatus = z.infer<typeof IndexStatusSchema>;

/**
 * GET /documents list items — intentionally excludes `content` (can be up
 * to 500k characters; the list view never needs it).
 */
export const DocumentSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  tags: z.array(z.string()),
  sourceType: z.enum(["manual", "upload"]),
  sourceName: z.string().nullable(),
  indexStatus: IndexStatusSchema,
  indexError: z.string().nullable(),
  chunkCount: z.number().int(),
  indexedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

/** GET /documents/:id — the summary fields plus the full content. */
export const DocumentDetailSchema = DocumentSummarySchema.extend({
  content: z.string(),
});
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

export const DocumentListResponseSchema = z.object({
  items: z.array(DocumentSummarySchema),
  nextCursor: z.string().nullable(),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;
