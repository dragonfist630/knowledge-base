"use client";

import { Suspense, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";

import { ChatView } from "@/features/chat/components/chat-view";
import type { ChatScope } from "@/features/chat/components/scope-selector";

/**
 * Renders `ChatView` exactly once, here, shared by /chat and
 * /chat/[conversationId] — rather than once per leaf `page.tsx`, which is
 * how this route used to be structured. See docs/DECISIONS.md D9.10 for
 * the bug this fixes: Next.js keeps a layout mounted across navigations to
 * its own child segments (that's the whole point of nested layouts), so
 * switching between /chat and /chat/[id] (or between two different [id]s)
 * now just updates `useParams()`'s `conversationId` and re-renders
 * `ChatView` with a new prop, instead of unmounting and remounting it —
 * which is what the old per-page structure did, and which is what forced
 * chat-view.tsx's own conversation-adoption step (see its `handleStarted`)
 * to reach for a raw `window.history.replaceState` call instead of a real
 * Next.js navigation. That workaround avoided one bug (a mid-stream
 * remount) by creating a worse one (Next's router losing track of the
 * real URL) — this restructuring removes the need for the workaround
 * instead of patching around it.
 *
 * `useParams()` (not a `params` prop) because a *layout* only ever
 * receives params for dynamic segments at or above its own level —
 * `conversationId` belongs to the *child* segment `[conversationId]`, one
 * level below this layout. `useParams()` is the client-side hook that
 * still resolves to the full, current route's params regardless of which
 * layout level calls it, so it correctly returns `undefined` on /chat and
 * the real id on /chat/[id].
 *
 * `useSearchParams()` (rather than a `searchParams` prop, which layouts
 * never receive at all — search-param-only changes must not invalidate a
 * persisted layout, which is the entire point of putting `ChatView` here)
 * needs the `<Suspense>` wrapper it always needs in this codebase — see
 * the (auth)/login page for the same pattern and docs/DECISIONS.md Phase 6
 * for why `documents/[id]/page.tsx` avoids it instead: unlike that page,
 * this component doesn't have the option of reading search params via
 * `use()` on a promise prop, since layouts don't get one.
 */
export default function ChatLayout({ children }: LayoutProps<"/chat">) {
  const params = useParams<{ conversationId?: string }>();
  return (
    <Suspense>
      <ChatLayoutInner conversationId={params.conversationId}>{children}</ChatLayoutInner>
    </Suspense>
  );
}

function ChatLayoutInner({ conversationId, children }: { conversationId?: string; children: React.ReactNode }) {
  const searchParams = useSearchParams();

  // `?documentIds=a,b` pre-scopes the composer — the deep link
  // features/documents/components/document-form.tsx's "Ask about this
  // doc" button produces. Only meaningful on a fresh /chat (a real
  // conversation already has its own scope), but reading it here rather
  // than gating on `!conversationId` costs nothing and needs no extra
  // state to go stale.
  const initialScope = useMemo((): ChatScope | undefined => {
    const raw = searchParams.get("documentIds");
    if (!raw) return undefined;
    const documentIds = raw.split(",").filter(Boolean);
    return documentIds.length > 0 ? { mode: "documents", documentIds } : undefined;
  }, [searchParams]);

  return (
    <>
      <ChatView conversationId={conversationId} initialScope={initialScope} />
      {children}
    </>
  );
}
