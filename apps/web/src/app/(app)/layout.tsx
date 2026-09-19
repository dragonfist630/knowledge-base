import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { MenuIcon } from "lucide-react";

import { NavLinks } from "@/components/nav-links";
import { ProviderBadge } from "@/components/provider-badge";
import { UserMenu } from "@/components/user-menu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/server";

/**
 * The (app) route group's shell: a fixed sidebar (Documents/Chat/Usage,
 * user menu, AI provider badge) on desktop, collapsing to a Sheet-based
 * off-canvas nav on mobile — see docs/DECISIONS.md Phase 6 for why this is
 * a small hand-rolled shell rather than shadcn's full Sidebar primitive
 * (that component's collapsible-rail/cookie-persisted-state machinery is
 * built for apps with many more nav sections than this one's fixed three).
 *
 * Re-checks auth with `getUser()` (verified against Supabase Auth, not
 * just a cookie read) rather than trusting proxy.ts's redirect alone —
 * proxy.ts documents itself as an optimistic check only; this is the
 * layout's own DAL-adjacent check, matching the Next.js authentication
 * guide's recommended split. It's defense in depth, not the app's real
 * authorization boundary — that's apps/api's AuthGuard, which verifies the
 * JWT on every request and is the only thing that ever touches real data.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const sidebarContent = (
    <div className="flex h-full flex-col gap-6">
      <Link href="/documents" className="text-lg font-semibold">
        Knowledge Base
      </Link>
      <NavLinks />
      <div className="mt-auto flex flex-col gap-3">
        <Suspense fallback={null}>
          <ProviderBadge />
        </Suspense>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-64 shrink-0 border-r bg-muted/40 p-4 md:flex">{sidebarContent}</aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-4">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                <MenuIcon className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-4">
              <SheetHeader className="sr-only p-0">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              {sidebarContent}
            </SheetContent>
          </Sheet>

          <div className="flex-1 md:hidden" />

          <div className="ml-auto flex items-center gap-3">
            <UserMenu email={user.email ?? "Signed in"} />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
