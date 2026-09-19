/**
 * Zod schemas for the usage page (Phase 6) — the one shared contract for
 * `GET /usage` between apps/web and apps/api. Backed by the `usage_summary`
 * Postgres RPC (supabase/migrations), which is `security invoker` and
 * already scopes every row to `auth.uid()` internally — this schema only
 * describes shape, not authorization (RLS/the RPC itself is the boundary,
 * same as every other feature in this app; see docs/DECISIONS.md).
 */

import { z } from "zod";

const DAYS_MIN = 1;
const DAYS_MAX = 365;
const DEFAULT_DAYS = 30;

export const UsageQuerySchema = z.object({
  /** How many trailing days to summarize, ending today. Maps to usage_summary's `p_from` (today - days). */
  days: z.coerce.number().int().min(DAYS_MIN).max(DAYS_MAX).default(DEFAULT_DAYS),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

/** Matches public.ai_usage_events' operation check constraint. */
export const UsageOperationSchema = z.enum(["chat", "embedding", "query_rewrite"]);
export type UsageOperation = z.infer<typeof UsageOperationSchema>;

/** One (day, operation, model) bucket, as usage_summary groups and sums them. */
export const UsageDayRowSchema = z.object({
  day: z.string(),
  operation: UsageOperationSchema,
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  eventCount: z.number().int(),
});
export type UsageDayRow = z.infer<typeof UsageDayRowSchema>;

/** Rows summed across the whole window, for the page's top-line stat tiles. */
export const UsageTotalsSchema = z.object({
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  eventCount: z.number().int(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageSummaryResponseSchema = z.object({
  /** ISO date the window starts at (today - days), echoing usage_summary's own `p_from` back so the UI can label the range without recomputing it. */
  from: z.string(),
  days: z.number().int(),
  totals: UsageTotalsSchema,
  rows: z.array(UsageDayRowSchema),
});
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;
