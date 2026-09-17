import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@kb/shared";

import type { ApiEnv } from "../config/env.js";

/**
 * One client per request, scoped to that request's user by sending their
 * JWT as the Authorization header alongside the publishable key. Every
 * query this client runs is evaluated under RLS as that user — there is no
 * separate "admin" client anywhere in apps/api (see docs/DECISIONS.md: no
 * service-role key in the API runtime).
 */
export function createUserScopedClient(env: ApiEnv, jwt: string): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A client with no user JWT attached — used only to call `auth.getClaims()`
 * for token verification itself (which needs a client instance but not a
 * signed-in session). Never used to query `public.*` tables: under RLS it
 * would see nothing anyway (no `anon` grants — see the Phase 1 migration).
 */
export function createAnonClient(env: ApiEnv): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
