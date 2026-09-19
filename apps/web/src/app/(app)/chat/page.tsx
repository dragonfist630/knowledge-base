"use client";

import { use, useMemo } from "react";

import { ChatView } from "@/features/chat/components/chat-view";
import type { ChatScope } from "@/features/chat/components/scope-selector";

/**
 * A fresh, not-yet-created conversation. `?documentIds=a,b` pre-scopes the
 * composer — the deep link features/documents/components/document-form.tsx's
 * "Ask about this doc" button produces.
 */
export default function ChatPage({ searchParams }: PageProps<"/chat">) {
  const resolvedSearchParams = use(searchParams);

  const initialScope = useMemo((): ChatScope | undefined => {
    const value = resolvedSearchParams.documentIds;
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return undefined;
    const documentIds = raw.split(",").filter(Boolean);
    return documentIds.length > 0 ? { mode: "documents", documentIds } : undefined;
  }, [resolvedSearchParams.documentIds]);

  return <ChatView initialScope={initialScope} />;
}
