/**
 * apps/api's own config surface, validated once at boot — separate from
 * @kb/ai's config.ts (Phase 2), which owns AI_* only. A bad value here fails
 * fast with a readable, aggregated message instead of surfacing later as a
 * confusing runtime error (see docs/DECISIONS.md, "No runtime-mutable global
 * config" — this is the one place config is read from, and it's read once).
 */

import { z } from "zod";

function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const requiredString = (name: string) =>
  z.preprocess(emptyToUndefined, z.string().min(1, `${name} is required`));

/** "true"/"false" (case-insensitive) from the environment -> boolean, defaulting when unset/empty. */
const boolEnv = (defaultValue: boolean) =>
  z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()).transform((v) => (v === undefined ? defaultValue : v === "true"));

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(["development", "test", "production"]).optional()).default(
    "development",
  ),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(3001),

  /** Origin the browser app runs on — the only origin CORS allows. */
  WEB_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()).default("http://localhost:3000"),

  SUPABASE_URL: requiredString("SUPABASE_URL").pipe(z.string().url()),
  SUPABASE_PUBLISHABLE_KEY: requiredString("SUPABASE_PUBLISHABLE_KEY"),
  /**
   * Local/self-hosted Supabase signs JWTs with a shared HS256 secret rather
   * than the asymmetric keys a hosted project's JWKS endpoint serves — see
   * docs/DECISIONS.md Phase 3 (D3.1) for why the auth guard needs this as an
   * explicit local fallback and when it's actually used. Optional: a hosted
   * project verifies entirely through getClaims()'s own JWKS fetch and never
   * touches this value.
   */
  SUPABASE_JWT_SECRET: optionalString,

  /** RAG_* knobs — consumed by packages/rag-core's chunker starting Phase 4; owned here since Phase 3 owns apps/api's env surface. */
  RAG_CHUNK_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(450),
  RAG_CHUNK_MAX_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(600),
  RAG_CHUNK_OVERLAP_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()).default(60),

  /**
   * RAG_* retrieval/chat knobs — consumed by apps/api/src/retrieval and
   * apps/api/src/chat starting Phase 5. See docs/DECISIONS.md Phase 5 for
   * why each default is what it is (mirrors the brief's own numbers).
   */
  RAG_TOP_K: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(8),
  RAG_MIN_SIMILARITY: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(1).optional()).default(0.25),
  RAG_CONTEXT_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(3500),
  RAG_HISTORY_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()).default(1500),
  /** Master on/off switch for query rewriting — set false to always retrieve on the raw question, even with prior turns. */
  RAG_QUERY_REWRITE: boolEnv(true),
  RAG_QUERY_REWRITE_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(5000),

  THROTTLE_DEFAULT_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(120),
  THROTTLE_DEFAULT_TTL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(
    60_000,
  ),
  THROTTLE_CHAT_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(20),
  THROTTLE_CHAT_TTL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(
    60_000,
  ),
  /** Per-IP ceiling checked before auth even runs (PreAuthThrottlerGuard) — see its own doc comment for why this exists as a separate bucket. */
  THROTTLE_PREAUTH_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(60),
  THROTTLE_PREAUTH_TTL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(
    60_000,
  ),
  /**
   * Optional. Unset (the default) keeps @nestjs/throttler's built-in
   * in-memory counters — correct for a single apps/api process, but each
   * additional replica then keeps its own counter (see docs/SCALING.md
   * item 2: effective limit becomes configured limit × instance count).
   * Set this to point every replica at the same Redis instance instead —
   * see RedisThrottlerStorage (apps/api/src/common/redis-throttler-storage.ts)
   * and docs/DECISIONS.md D9.15. Same "sane default, real infrastructure
   * opt-in" posture as AI_CHAT_PROVIDER/AI_EMBEDDING_PROVIDER defaulting to
   * mock.
   */
  REDIS_URL: optionalString,
});

export type ApiEnv = z.infer<typeof EnvSchema>;

/**
 * Parses and validates process.env once. Called from main.ts before
 * NestFactory.create so a bad config never gets as far as starting the HTTP
 * server. Throws a single Error with every problem listed, not just the
 * first one.
 */
export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Invalid apps/api environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
