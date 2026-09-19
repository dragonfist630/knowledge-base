import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/login", "/signup", "/auth/callback"];

/**
 * Runs on (almost) every request (see `config.matcher` below):
 *  1. Refreshes the Supabase session, so a Server Component never sees a
 *     stale/expired access token — this is the one place in the app that
 *     writes the refreshed auth cookies back to the response.
 *  2. Redirects unauthenticated visitors away from the (app) route group
 *     to /login, and signed-in visitors away from /login and /signup to
 *     the app (this is only an optimistic check, see below).
 *
 * This is an OPTIMISTIC check only (session cookie present, not verified
 * against the DB) — it's fine for UX-level redirects, but it is not the
 * app's security boundary. That boundary is apps/api's AuthGuard, which
 * verifies the JWT signature on every request and is the only thing that
 * ever touches real data (see docs/DECISIONS.md Phase 3, D3.1/D3.6) — the
 * same "Proxy for optimistic checks, verify for real close to the data"
 * split the Next.js authentication guide recommends.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname.startsWith(route));

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/documents";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/documents";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets and image optimization
     * files — running Proxy against those would just add latency for no
     * benefit, since none of them are auth-gated.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
