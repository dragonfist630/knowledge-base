/**
 * The one JSON error shape every apps/api error response uses — built by
 * apps/api/src/common/http-exception.filter.ts, consumed by apps/web so it
 * never has to guess at an error body's shape. See docs/DECISIONS.md Phase 3
 * for the code -> HTTP status mapping.
 */

import { z } from "zod";

export const ApiFieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ApiFieldError = z.infer<typeof ApiFieldErrorSchema>;

export const ApiErrorResponseSchema = z.object({
  requestId: z.string(),
  code: z.string(),
  message: z.string(),
  fieldErrors: z.array(ApiFieldErrorSchema).optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
