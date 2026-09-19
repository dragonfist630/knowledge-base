"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CitationSnapshot, MessageRole } from "@kb/shared";

import { CitationBadge } from "@/features/chat/components/citation-badge";
import { SourcesPanel, type SourcesPanelItem } from "@/features/chat/components/sources-panel";
import { citationHandlers, remarkCitations } from "@/lib/markdown/remark-citations";
import { cn } from "@/lib/utils";

interface CitationMarkerProps {
  sourceid: string;
}

export function Message({
  role,
  content,
  sources,
  citationsById,
  pending,
}: {
  role: MessageRole;
  content: string;
  sources: SourcesPanelItem[];
  citationsById?: Map<string, CitationSnapshot>;
  /** True for the in-flight assistant turn before its first token arrives — shows a "Searching your documents…" placeholder instead of an empty bubble. */
  pending?: boolean;
}) {
  const isUser = role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {pending ? (
          <p className="text-muted-foreground flex items-center gap-2 italic">
            <span className="bg-muted-foreground/60 size-1.5 animate-pulse rounded-full" />
            Searching your documents…
          </p>
        ) : isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkCitations]}
              remarkRehypeOptions={{ handlers: citationHandlers }}
              components={{
                // @ts-expect-error -- "citation-marker" is our own custom hast tag (see lib/markdown/remark-citations.ts), not a real HTML element, so it isn't in react-markdown's built-in Components type.
                "citation-marker": ({ sourceid }: CitationMarkerProps) => (
                  <CitationBadge sourceId={sourceid} citation={citationsById?.get(sourceid)} />
                ),
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}

        {!isUser && !pending ? <SourcesPanel sources={sources} /> : null}
      </div>
    </div>
  );
}
