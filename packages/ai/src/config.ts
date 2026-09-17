import { z } from "zod";

import { AiError } from "./errors.js";
import { PROVIDER_NAMES, PROVIDER_PRESETS, type ProviderCapabilities, type ProviderName } from "./presets.js";

/** Must equal document_chunks.embedding's column width (vector(1536)) — see supabase/migrations. */
export const REQUIRED_EMBEDDING_DIMENSIONS = 1536;

export interface ResolvedProviderConfig {
  provider: ProviderName;
  model: string;
  /** Always resolved by the time config comes out of resolveAiConfig — "mock://local" for the mock provider. */
  baseUrl: string;
  apiKey: string | undefined;
  capabilities: ProviderCapabilities;
}

export interface ResolvedChatConfig extends ResolvedProviderConfig {
  supportsTemperature: boolean;
}

export interface ResolvedEmbeddingConfig extends ResolvedProviderConfig {
  dimensions: number;
}

export interface ResolvedAiConfig {
  chat: ResolvedChatConfig;
  embedding: ResolvedEmbeddingConfig;
  requestTimeoutMs: number;
  maxRetries: number;
}

function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const RawEnvSchema = z.object({
  AI_CHAT_PROVIDER: z.preprocess(emptyToUndefined, z.string().optional()).default("mock"),
  AI_CHAT_MODEL: z.preprocess(emptyToUndefined, z.string().optional()).default("mock-chat"),
  AI_CHAT_BASE_URL: optionalString,
  AI_CHAT_API_KEY: optionalString,
  AI_CHAT_SUPPORTS_TEMPERATURE: z.preprocess(emptyToUndefined, z.string().optional()).default("true"),

  AI_EMBEDDING_PROVIDER: z.preprocess(emptyToUndefined, z.string().optional()).default("mock"),
  AI_EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().optional()).default("mock-embedding"),
  AI_EMBEDDING_BASE_URL: optionalString,
  AI_EMBEDDING_API_KEY: optionalString,
  AI_EMBEDDING_DIMENSIONS: z.preprocess(emptyToUndefined, z.coerce.number().optional()).default(
    REQUIRED_EMBEDDING_DIMENSIONS,
  ),

  AI_REQUEST_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()).default(60_000),
  AI_MAX_RETRIES: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()).default(2),

  /** Generic fallback API key, tried after the provider-specific env var. */
  AI_API_KEY: optionalString,
});

type RawEnv = z.infer<typeof RawEnvSchema>;

function providerList(predicate: (p: ProviderName) => boolean): string {
  return PROVIDER_NAMES.filter(predicate).join("|");
}

interface ResolveKindArgs {
  kind: "chat" | "embedding";
  providerRaw: string;
  model: string;
  baseUrlOverride: string | undefined;
  apiKeyOverride: string | undefined;
  env: NodeJS.ProcessEnv;
  issues: string[];
}

function resolveProvider(args: ResolveKindArgs): ResolvedProviderConfig {
  const { kind, providerRaw, model, baseUrlOverride, apiKeyOverride, env, issues } = args;
  const envVarName = kind === "chat" ? "AI_CHAT_PROVIDER" : "AI_EMBEDDING_PROVIDER";

  const isKnownProvider = (PROVIDER_NAMES as readonly string[]).includes(providerRaw);
  if (!isKnownProvider) {
    issues.push(
      `${envVarName}=${providerRaw} is not a known provider. Valid values: ${PROVIDER_NAMES.join("|")}.`,
    );
  }
  // Fall back to mock so the rest of resolution still runs and reports any
  // OTHER issues in the same pass, instead of stopping at the first one.
  const provider = (isKnownProvider ? providerRaw : "mock") as ProviderName;
  const preset = PROVIDER_PRESETS[provider];

  if (kind === "embedding" && provider !== "mock" && !preset.capabilities.embeddings) {
    const alternatives = providerList((p) => PROVIDER_PRESETS[p].capabilities.embeddings);
    issues.push(
      `${capitalize(provider)} has no embeddings API; set AI_EMBEDDING_PROVIDER=${alternatives}`,
    );
  }

  const baseUrl = baseUrlOverride ?? preset.baseUrl;
  if (baseUrl === undefined && provider !== "mock") {
    const baseUrlEnvName = kind === "chat" ? "AI_CHAT_BASE_URL" : "AI_EMBEDDING_BASE_URL";
    issues.push(`${baseUrlEnvName} is required when ${envVarName}=${provider}.`);
  }

  const apiKey =
    apiKeyOverride ?? (preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined) ?? env.AI_API_KEY;

  if (preset.requiresKey && !apiKey) {
    const apiKeyEnvName = kind === "chat" ? "AI_CHAT_API_KEY" : "AI_EMBEDDING_API_KEY";
    const presetKeyHint = preset.apiKeyEnv ? ` (e.g. ${preset.apiKeyEnv})` : "";
    issues.push(
      `${capitalize(provider)} requires an API key. Set ${apiKeyEnvName}${presetKeyHint} or AI_API_KEY.`,
    );
  }

  return {
    provider,
    model,
    baseUrl: baseUrl ?? "mock://local",
    apiKey,
    capabilities: preset.capabilities,
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() !== "false" && value.trim() !== "0";
}

/**
 * Resolves the full AI config from environment variables, or throws one
 * aggregated `AiError` (code: "config") listing every problem found — not
 * just the first — so a misconfigured .env can be fixed in one pass.
 *
 * Resolution order for base URL and API key: explicit override wins, then
 * the provider preset, then an error.
 */
export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env): ResolvedAiConfig {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new AiError("config", `Invalid AI configuration:\n- ${messages.join("\n- ")}`);
  }
  const raw: RawEnv = parsed.data;
  const issues: string[] = [];

  const chatBase = resolveProvider({
    kind: "chat",
    providerRaw: raw.AI_CHAT_PROVIDER,
    model: raw.AI_CHAT_MODEL,
    baseUrlOverride: raw.AI_CHAT_BASE_URL,
    apiKeyOverride: raw.AI_CHAT_API_KEY,
    env,
    issues,
  });

  const embeddingBase = resolveProvider({
    kind: "embedding",
    providerRaw: raw.AI_EMBEDDING_PROVIDER,
    model: raw.AI_EMBEDDING_MODEL,
    baseUrlOverride: raw.AI_EMBEDDING_BASE_URL,
    apiKeyOverride: raw.AI_EMBEDDING_API_KEY,
    env,
    issues,
  });

  if (raw.AI_EMBEDDING_DIMENSIONS !== REQUIRED_EMBEDDING_DIMENSIONS) {
    issues.push(
      `AI_EMBEDDING_DIMENSIONS=${raw.AI_EMBEDDING_DIMENSIONS} but must be ${REQUIRED_EMBEDDING_DIMENSIONS} to ` +
        `match document_chunks.embedding's column width (vector(${REQUIRED_EMBEDDING_DIMENSIONS})). To use a ` +
        `different dimension, run the migration template in docs/PROVIDERS.md to alter the column first, then ` +
        `update this value.`,
    );
  }

  if (issues.length > 0) {
    throw new AiError("config", `Invalid AI configuration:\n- ${issues.join("\n- ")}`);
  }

  return {
    chat: { ...chatBase, supportsTemperature: parseBoolean(raw.AI_CHAT_SUPPORTS_TEMPERATURE) },
    embedding: { ...embeddingBase, dimensions: raw.AI_EMBEDDING_DIMENSIONS },
    requestTimeoutMs: raw.AI_REQUEST_TIMEOUT_MS,
    maxRetries: raw.AI_MAX_RETRIES,
  };
}
