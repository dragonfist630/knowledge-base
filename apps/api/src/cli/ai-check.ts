import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { createAi, isAiError, type AiErrorCode } from "@kb/ai";

/**
 * `pnpm ai:check` — loads the same AI_* config the app would use at runtime,
 * prints exactly which provider/model/base URL it resolved to (with the API
 * key masked), then makes one real 1-token chat completion and one real
 * 1-input embedding call so a misconfigured key, base URL, or model name
 * fails loudly here instead of surfacing later as a 500 in the UI.
 *
 * Safe to run with no AI_* env set at all: it exercises the keyless mock
 * provider in that case (still a useful smoke test — it confirms the app's
 * config wiring itself works even before any real provider is configured).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file runs from dist/cli/ai-check.js — same three levels up to the
// repo root .env as apps/api/src/main.ts's dist/main.js.
loadEnv({ path: path.resolve(__dirname, "../../../../.env") });

const HINTS: Partial<Record<AiErrorCode, string>> = {
  auth: "Double-check the API key — is it set, current, and for the right provider?",
  rate_limit: "This is retryable; the app backs off automatically, but check your plan's rate limits if it persists.",
  bad_request: "Check AI_CHAT_MODEL / AI_EMBEDDING_MODEL — the provider likely doesn't recognize that model name.",
  timeout: "The provider took too long to respond. Check AI_REQUEST_TIMEOUT_MS or the provider's status page.",
  unavailable: "Could not reach the provider. If this is Ollama, confirm `ollama serve` is running.",
  invalid_response: "The provider responded, but not in the shape we expected — see the detail above.",
  config: "Fix the AI_* environment variables listed above, then re-run `pnpm ai:check`.",
  aborted: "The request was aborted before it could complete.",
};

function maskedLine(label: string, d: { provider: string; model: string; baseUrl: string; apiKeyMasked?: string }) {
  const key = d.apiKeyMasked ? ` (key: ${d.apiKeyMasked})` : "";
  console.info(`  ${label}: ${d.provider} / ${d.model} @ ${d.baseUrl}${key}`);
}

function fail(step: string, error: unknown, elapsedMs: number): never {
  console.error(`\n✗ ${step} failed after ${elapsedMs}ms`);
  if (isAiError(error)) {
    console.error(`  [${error.code}] ${error.message}`);
    if (error.detail) {
      console.error(`  detail: ${error.detail}`);
    }
    const hint = HINTS[error.code];
    if (hint) {
      console.error(`  → ${hint}`);
    }
  } else {
    console.error(`  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
  console.error("\nAI check failed.");
  process.exit(1);
}

async function main(): Promise<void> {
  console.info("AI check\n");

  let ai;
  try {
    ai = createAi(process.env);
  } catch (error) {
    fail("Resolving AI configuration", error, 0);
  }

  const { chat, embedding } = ai.describe();
  maskedLine("chat     ", chat);
  maskedLine("embedding", { ...embedding, model: `${embedding.model} [${embedding.dimensions} dims]` });

  console.info("\nSending a 1-token chat completion...");
  const chatStart = Date.now();
  try {
    const result = await ai.chat.complete(
      [{ role: "user", content: "Reply with a single word." }],
      { maxOutputTokens: 1 },
    );
    const elapsed = Date.now() - chatStart;
    console.info(
      `  ✓ ok in ${elapsed}ms — finish: ${result.finishReason}, usage: ${result.usage.promptTokens} prompt + ` +
        `${result.usage.completionTokens} completion = ${result.usage.totalTokens} tokens ` +
        `(estimated: ${result.usage.estimated})`,
    );
  } catch (error) {
    fail("Chat check", error, Date.now() - chatStart);
  }

  console.info("\nSending a 1-input embedding request...");
  const embedStart = Date.now();
  try {
    const result = await ai.embeddings.embed(["ai-check smoke test"]);
    const elapsed = Date.now() - embedStart;
    const dims = result.vectors[0]?.length ?? 0;
    console.info(
      `  ✓ ok in ${elapsed}ms — ${dims} dims, usage: ${result.usage.totalTokens} tokens ` +
        `(estimated: ${result.usage.estimated})`,
    );
  } catch (error) {
    fail("Embedding check", error, Date.now() - embedStart);
  }

  console.info("\nAI check passed.");
}

await main();
