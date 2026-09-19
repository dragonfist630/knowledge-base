import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@kb/shared";

/**
 * The only Supabase client this app ever uses in the browser. It talks
 * directly to Supabase Auth (sign in/up/out, session refresh) — it is
 * NOT used to query app data (documents, conversations, messages): every
 * data request goes through apps/api's REST layer instead (see
 * lib/api/client.ts), which is the one place RLS-scoped queries happen,
 * matching apps/api's own "RLS is the only authorization boundary"
 * invariant (docs/DECISIONS.md). This client only ever needs the
 * publishable key, never a secret.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
