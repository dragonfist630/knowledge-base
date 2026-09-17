import { describe, expect, it } from "vitest";

import { REQUIRED_EMBEDDING_DIMENSIONS, resolveAiConfig } from "./config.js";
import { isAiError } from "./errors.js";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("resolveAiConfig", () => {
  it("defaults to mock/mock with no env set — keyless demo mode", () => {
    const config = resolveAiConfig(env());
    expect(config.chat.provider).toBe("mock");
    expect(config.embedding.provider).toBe("mock");
    expect(config.embedding.dimensions).toBe(REQUIRED_EMBEDDING_DIMENSIONS);
    expect(config.chat.baseUrl).toBe("mock://local");
  });

  it("resolves a preset's base URL and API key env var", () => {
    const config = resolveAiConfig(
      env({
        AI_CHAT_PROVIDER: "openai",
        AI_CHAT_MODEL: "gpt-4.1-mini",
        OPENAI_API_KEY: "sk-preset-key",
        AI_EMBEDDING_PROVIDER: "mock",
      }),
    );
    expect(config.chat.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.chat.apiKey).toBe("sk-preset-key");
  });

  it("an explicit override wins over the preset", () => {
    const config = resolveAiConfig(
      env({
        AI_CHAT_PROVIDER: "openai",
        AI_CHAT_MODEL: "gpt-4.1-mini",
        AI_CHAT_BASE_URL: "https://my-proxy.example.com/v1",
        AI_CHAT_API_KEY: "sk-override-key",
        OPENAI_API_KEY: "sk-preset-key",
        AI_EMBEDDING_PROVIDER: "mock",
      }),
    );
    expect(config.chat.baseUrl).toBe("https://my-proxy.example.com/v1");
    expect(config.chat.apiKey).toBe("sk-override-key");
  });

  it("falls back to the generic AI_API_KEY when no provider-specific key is set", () => {
    const config = resolveAiConfig(
      env({
        AI_CHAT_PROVIDER: "openai",
        AI_CHAT_MODEL: "gpt-4.1-mini",
        AI_API_KEY: "sk-generic-key",
        AI_EMBEDDING_PROVIDER: "mock",
      }),
    );
    expect(config.chat.apiKey).toBe("sk-generic-key");
  });

  it("rejects an unknown provider", () => {
    expect(() => resolveAiConfig(env({ AI_CHAT_PROVIDER: "definitely-not-a-provider" }))).toThrowError(
      /not a known provider/,
    );
  });

  it("rejects an embedding provider with no embeddings API, naming valid alternatives", () => {
    let error: unknown;
    try {
      resolveAiConfig(
        env({
          AI_EMBEDDING_PROVIDER: "groq",
          GROQ_API_KEY: "gsk-key",
        }),
      );
    } catch (e) {
      error = e;
    }
    expect(isAiError(error)).toBe(true);
    expect((error as Error).message).toMatch(/Groq has no embeddings API; set AI_EMBEDDING_PROVIDER=/);
    expect((error as Error).message).toMatch(/openai/);
  });

  it("rejects a provider that requires a key when none is configured", () => {
    expect(() => resolveAiConfig(env({ AI_CHAT_PROVIDER: "openai", AI_EMBEDDING_PROVIDER: "mock" }))).toThrowError(
      /requires an API key/,
    );
  });

  it("rejects provider=custom with no base URL override", () => {
    expect(() => resolveAiConfig(env({ AI_CHAT_PROVIDER: "custom", AI_EMBEDDING_PROVIDER: "mock" }))).toThrowError(
      /AI_CHAT_BASE_URL is required/,
    );
  });

  it("accepts provider=custom once a base URL override is given", () => {
    const config = resolveAiConfig(
      env({
        AI_CHAT_PROVIDER: "custom",
        AI_CHAT_BASE_URL: "http://localhost:8080/v1",
        AI_EMBEDDING_PROVIDER: "mock",
      }),
    );
    expect(config.chat.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("rejects AI_EMBEDDING_DIMENSIONS != 1536, mentioning the migration template", () => {
    expect(() =>
      resolveAiConfig(env({ AI_EMBEDDING_DIMENSIONS: "768", AI_EMBEDDING_PROVIDER: "mock" })),
    ).toThrowError(/must be 1536/);
  });

  it("aggregates every problem into one error instead of stopping at the first", () => {
    let error: unknown;
    try {
      resolveAiConfig(
        env({
          AI_CHAT_PROVIDER: "custom", // missing base url
          AI_EMBEDDING_PROVIDER: "groq", // no embeddings API
          AI_EMBEDDING_DIMENSIONS: "42", // wrong dimensions
        }),
      );
    } catch (e) {
      error = e;
    }
    const message = (error as Error).message;
    expect(message).toMatch(/AI_CHAT_BASE_URL is required/);
    expect(message).toMatch(/Groq has no embeddings API/);
    expect(message).toMatch(/must be 1536/);
  });

  it("AI_CHAT_SUPPORTS_TEMPERATURE defaults to true and can be turned off", () => {
    const defaultConfig = resolveAiConfig(env());
    expect(defaultConfig.chat.supportsTemperature).toBe(true);

    const disabled = resolveAiConfig(env({ AI_CHAT_SUPPORTS_TEMPERATURE: "false" }));
    expect(disabled.chat.supportsTemperature).toBe(false);
  });

  it("treats an empty-string env var the same as unset", () => {
    const config = resolveAiConfig(env({ AI_CHAT_BASE_URL: "", AI_CHAT_PROVIDER: "mock" }));
    expect(config.chat.baseUrl).toBe("mock://local");
  });
});
