import OpenAI from "openai";
import type { APIError } from "openai";
import { describe, expect, it } from "vitest";

import { AiError, isAiError } from "../errors.js";
import { mapOpenAiError } from "./map-error.js";

/**
 * Direct unit tests for the status-code -> AiError.code mapping, built via
 * OpenAI.APIError.generate() (the same factory the SDK's own request
 * pipeline uses to turn an HTTP response into a typed error) so we don't
 * depend on each error class's exact constructor signature.
 */
function apiErrorFor(status: number, message = "boom"): APIError {
  return OpenAI.APIError.generate(status, { error: { message } }, message, new Headers());
}

describe("mapOpenAiError", () => {
  it("maps 429 to rate_limit", () => {
    const result = mapOpenAiError(apiErrorFor(429), "openai");
    expect(result).toBeInstanceOf(AiError);
    expect(result.code).toBe("rate_limit");
    expect(result.status).toBe(429);
    expect(result.provider).toBe("openai");
  });

  it("maps 401 to auth", () => {
    expect(mapOpenAiError(apiErrorFor(401), "openai").code).toBe("auth");
  });

  it("maps 403 to auth", () => {
    expect(mapOpenAiError(apiErrorFor(403), "openai").code).toBe("auth");
  });

  it("maps 400 to bad_request", () => {
    expect(mapOpenAiError(apiErrorFor(400), "openai").code).toBe("bad_request");
  });

  it("maps 404 to bad_request", () => {
    expect(mapOpenAiError(apiErrorFor(404), "openai").code).toBe("bad_request");
  });

  it("maps 409 (no specific branch) to the generic bad_request fallback", () => {
    expect(mapOpenAiError(apiErrorFor(409), "openai").code).toBe("bad_request");
  });

  it("maps 422 (no specific branch) to the generic bad_request fallback", () => {
    expect(mapOpenAiError(apiErrorFor(422), "openai").code).toBe("bad_request");
  });

  it("maps 500 to unavailable", () => {
    expect(mapOpenAiError(apiErrorFor(500), "openai").code).toBe("unavailable");
  });

  it("maps 503 to unavailable", () => {
    expect(mapOpenAiError(apiErrorFor(503), "openai").code).toBe("unavailable");
  });

  it("maps a connection error (no status/headers) to unavailable", () => {
    const error = OpenAI.APIError.generate(undefined, undefined, "network down", undefined);
    expect(mapOpenAiError(error, "openai").code).toBe("unavailable");
  });

  it("adds an Ollama-specific hint to unavailable connection errors when provider is ollama", () => {
    const error = OpenAI.APIError.generate(undefined, undefined, "network down", undefined);
    const result = mapOpenAiError(error, "ollama");
    expect(result.code).toBe("unavailable");
    expect(result.detail).toMatch(/ollama serve/);
  });

  it("uses a generic (non-Ollama) message for other providers", () => {
    const error = OpenAI.APIError.generate(undefined, undefined, "network down", undefined);
    const result = mapOpenAiError(error, "groq");
    expect(result.detail).toBe("Could not reach groq.");
    expect(result.detail).not.toMatch(/ollama/i);
  });

  it("maps APIUserAbortError to aborted", () => {
    const error = new OpenAI.APIUserAbortError();
    expect(mapOpenAiError(error, "openai").code).toBe("aborted");
  });

  it("maps APIConnectionTimeoutError to timeout", () => {
    const error = new OpenAI.APIConnectionTimeoutError();
    expect(mapOpenAiError(error, "openai").code).toBe("timeout");
  });

  it("passes an already-AiError straight through unchanged", () => {
    const original = new AiError("config", "bad config");
    const result = mapOpenAiError(original, "openai");
    expect(result).toBe(original);
  });

  it("maps a completely unexpected error to invalid_response", () => {
    const result = mapOpenAiError(new Error("something weird"), "openai");
    expect(result.code).toBe("invalid_response");
  });

  it("maps a non-Error thrown value to invalid_response without throwing itself", () => {
    const result = mapOpenAiError("a raw string was thrown", "openai");
    expect(isAiError(result)).toBe(true);
    expect(result.code).toBe("invalid_response");
  });
});
