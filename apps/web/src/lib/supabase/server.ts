import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@kb/shared";

/**
 * A Supabase client for Server Components, Server Actions, and Route
 * Handlers — reads/writes the session via Next's cookie store. `cookies()`
 * is async in this Next.js version, so this factory is async too.
 *
 * Server Components can't set cookies (Next.js throws), which is fine
 * here: a Server Component only ever reads the session to render auth
 * state; refreshing it is proxy.ts's job (see src/proxy.ts), which runs
 * on every request and can write the refreshed cookies to the response.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component — no-op, see docstring above.
          }
        },
      },
    },
  );
}
