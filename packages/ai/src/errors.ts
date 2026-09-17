/**
 * The one error type every ChatModel/EmbeddingModel implementation throws.
 * Nest's global exception filter (Phase 3) maps `AiError.code` to an HTTP
 * status and a friendly UI message, so adapters must never leak raw SDK/HTTP
 * errors — see `openai-compatible/map-error.ts`.
 */

export const AI_ERROR_CODES = [
  "auth",
  "rate_limit",
  "bad_request",
  "timeout",
  "unavailable",
  "aborted",
  "invalid_response",
  "config",
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** Codes retry.ts will retry (with backoff) before giving up. */
export const RETRYABLE_AI_ERROR_CODES: ReadonlySet<AiErrorCode> = new Set([
  "rate_limit",
  "unavailable",
  "timeout",
]);

export interface AiErrorOptions {
  cause?: unknown;
  provider?: string;
  /** HTTP status from the upstream response, when there was one. */
  status?: number;
  /** Extra context for logs/CLI output — never shown raw to end users. */
  detail?: string;
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly detail?: string;

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AiError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.detail = options.detail;
  }

  get retryable(): boolean {
    return RETRYABLE_AI_ERROR_CODES.has(this.code);
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
