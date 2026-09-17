import { AiError, isAiError } from "./errors.js";

export interface RetryOptions {
  maxRetries: number;
  /** Base delay in ms before the first retry; doubles each attempt. */
  baseDelayMs?: number;
  /** Ceiling for the backoff delay, before jitter is applied. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Overridable for tests — defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for tests — defaults to Math.random. */
  random?: () => number;
}

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(toAbortError());
      },
      { once: true },
    );
  });
}

function toAbortError(): AiError {
  return new AiError("aborted", "Request aborted during retry backoff.");
}

/**
 * Exponential backoff with full jitter, retrying only AiErrors whose code is
 * in RETRYABLE_AI_ERROR_CODES (rate_limit, unavailable, timeout). Any other
 * error — including a non-AiError thrown by a bug elsewhere — is rethrown
 * immediately without retrying.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxRetries,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    signal,
    sleep = (ms) => defaultSleep(ms, signal),
    random = Math.random,
  } = options;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const canRetry = isAiError(error) && error.retryable && attempt < maxRetries;
      if (!canRetry) {
        throw error;
      }
      const cappedDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jittered = random() * cappedDelay;
      attempt += 1;
      await sleep(jittered);
    }
  }
}
