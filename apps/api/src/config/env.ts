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

  THROTTLE_DEFAULT_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(120),
  THROTTLE_DEFAULT_TTL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(
    60_000,
  ),
  THROTTLE_CHAT_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(20),
  THROTTLE_CHAT_TTL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()).default(
    60_000,
  ),
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
