import OpenAI from "openai";

import { AiError } from "../errors.js";

/**
 * Translates whatever the `openai` SDK throws (or a generic network/runtime
 * error) into our own AiError, so nothing outside this file ever needs to
 * know the SDK's error shape. Nest's exception filter (Phase 3) then maps
 * AiError.code to an HTTP status.
 */
export function mapOpenAiError(error: unknown, provider: string): AiError {
  if (error instanceof OpenAI.APIUserAbortError) {
    return new AiError("aborted", "Request aborted.", { cause: error, provider });
  }

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiError("timeout", `${provider} request timed out.`, { cause: error, provider });
  }

  if (error instanceof OpenAI.APIConnectionError) {
    const detail = isOllama(provider)
      ? "Could not reach Ollama — is `ollama serve` running?"
      : `Could not reach ${provider}.`;
    return new AiError("unavailable", detail, { cause: error, provider, detail });
  }

  if (error instanceof OpenAI.RateLimitError) {
    return new AiError("rate_limit", `${provider} rate limit exceeded.`, {
      cause: error,
      provider,
      status: error.status,
    });
  }

  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new AiError("auth", `${provider} rejected the API key.`, {
      cause: error,
      provider,
      status: error.status,
    });
  }

  if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.NotFoundError) {
    return new AiError("bad_request", `${provider} rejected the request: ${error.message}`, {
      cause: error,
      provider,
      status: error.status,
    });
  }

  if (error instanceof OpenAI.InternalServerError) {
    return new AiError("unavailable", `${provider} returned a server error.`, {
      cause: error,
      provider,
      status: error.status,
    });
  }

  if (error instanceof OpenAI.APIError) {
    // Any other status the SDK recognized as an API error but we haven't
    // special-cased above (e.g. 409/422) — group with bad_request since it's
    // caller-fixable, not a transient/infra problem.
    return new AiError("bad_request", `${provider} returned an error: ${error.message}`, {
      cause: error,
      provider,
      status: error.status,
    });
  }

  if (error instanceof AiError) {
    return error;
  }

  return new AiError("invalid_response", `Unexpected error calling ${provider}: ${String(error)}`, {
    cause: error,
    provider,
  });
}

function isOllama(provider: string): boolean {
  return provider.toLowerCase() === "ollama";
}
