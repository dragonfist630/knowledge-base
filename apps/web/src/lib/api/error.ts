import type { ApiErrorResponse, ApiFieldError } from "@kb/shared";

/**
 * Thrown by lib/api/client.ts for any non-2xx response. Carries the parsed
 * apps/api error body (see @kb/shared/errors.ts) when the server sent one
 * in its documented shape, so callers can show `message` directly or map
 * `fieldErrors` onto a form without re-parsing anything.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly fieldErrors: ApiFieldError[] | undefined;

  constructor(status: number, body: ApiErrorResponse | undefined, fallbackMessage: string) {
    super(body?.message ?? fallbackMessage);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code ?? "unknown_error";
    this.requestId = body?.requestId;
    this.fieldErrors = body?.fieldErrors;
  }
}
