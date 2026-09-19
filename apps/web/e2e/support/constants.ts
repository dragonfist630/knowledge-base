/**
 * Fixed ports/secret shared between global-setup.ts (which starts the
 * ephemeral backend) and playwright.config.ts (whose `webServer` entries
 * need to know those ports *before* global-setup has run, since
 * `webServer.env` is evaluated at config-load time — see docs/DECISIONS.md
 * Phase 6, Gate 6). Same fixed-defaults-overridable-by-env pattern as
 * apps/api's Gate 3 harness (test/e2e/global-setup.ts).
 */

export const E2E_POSTGREST_PORT = Number(process.env.E2E_POSTGREST_PORT ?? 4111);
export const E2E_GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT ?? 4110);
export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 4101);
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4100);

// The fixed secret every bare `supabase start` signs local dev JWTs with —
// see supabase/config.toml's closing note and docs/DECISIONS.md D3.1. Also
// what this harness's auth-gateway.ts signs with, and what apps/api verifies
// against (either via a real Supabase project sharing this secret, or its
// AuthGuard's local-HS256 fallback — see apps/api/src/auth/auth.guard.ts).
export const E2E_JWT_SECRET = process.env.E2E_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";

export const E2E_DB_NAME = process.env.E2E_WEB_DB_NAME ?? "kb_e2e_web";
export const E2E_SUPERUSER_URL = process.env.E2E_POSTGRES_SUPERUSER_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";

export const E2E_GATEWAY_URL = `http://127.0.0.1:${E2E_GATEWAY_PORT}`;
export const E2E_API_URL = `http://127.0.0.1:${E2E_API_PORT}`;
export const E2E_WEB_URL = `http://127.0.0.1:${E2E_WEB_PORT}`;

// Matches the anon/service-role placeholders apps/api's env schema accepts
// (it never validates these against a real Supabase project — see
// apps/api/src/config/env.ts) — auth-gateway.ts doesn't check them at all,
// it only verifies the bearer JWT it mints itself.
export const E2E_ANON_KEY = "e2e-anon-key";
export const E2E_SERVICE_ROLE_KEY = "e2e-service-role-key";
