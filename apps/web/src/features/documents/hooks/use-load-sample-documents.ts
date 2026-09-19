"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DocumentDetailSchema, type DocumentCreate } from "@kb/shared";

import { apiFetch } from "@/lib/api/client";
import { documentsKeys } from "@/features/documents/hooks/use-documents";

/**
 * Dev-only "Load sample documents" button. The Phase 6 brief describes
 * this as calling "the seed endpoint", but apps/api has no such endpoint
 * (scripts/seed.mjs — the CLI seed script — is still an unimplemented
 * Phase 0 placeholder, tracked separately). Rather than add new backend
 * surface area just for this nicety, this loops the same POST /documents
 * the "New document" button already calls, so every sample document goes
 * through the real create -> chunk -> embed pipeline like any other
 * document. See docs/DECISIONS.md Phase 6.
 */
const SAMPLE_DOCUMENTS: DocumentCreate[] = [
  {
    title: "Getting Started with the Knowledge Base",
    tags: ["guide", "onboarding"],
    content:
      "# Getting Started\n\nThis Knowledge Base lets you write documents and then ask questions about them in the Chat tab. Every document you create or edit is automatically chunked and embedded, so it becomes searchable within a few seconds.\n\n## Tips\n\n- Use headings (`#`, `##`) to organize long documents — the chunker and the chat citations both respect section boundaries.\n- Tag documents so you can filter the list and scope chat questions to just a few documents.\n- The status badge next to a document tells you whether it's still indexing.",
  },
  {
    title: "Vector Search, Briefly",
    tags: ["reference", "rag"],
    content:
      "# Vector Search, Briefly\n\nWhen you ask a question in Chat, the app doesn't search for exact keyword matches. Instead it converts your question into a numeric vector (an embedding) and compares it against the stored vectors for every chunk of your documents, using cosine similarity.\n\n## Why chunks, not whole documents\n\nEmbedding an entire long document loses detail — the vector ends up representing an average of everything in it. Splitting into smaller, heading-aware chunks keeps each vector focused on one topic, which makes retrieval far more precise.\n\n## Provider-agnostic\n\nThe chat model and the embedding model are configured independently, and either can be swapped to a different OpenAI-API-compatible provider through environment variables alone — no code changes required.",
  },
  {
    title: "Markdown Cheat Sheet",
    tags: ["reference"],
    content:
      "# Markdown Cheat Sheet\n\n## Text\n\n**bold**, *italic*, `inline code`\n\n## Lists\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n## Links and tables\n\n[Example link](https://example.com)\n\n| Column A | Column B |\n| --- | --- |\n| value | value |\n\n## Code block\n\n```ts\nfunction hello(name: string) {\n  return `Hello, ${name}!`;\n}\n```",
  },
];

export function useLoadSampleDocuments() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const created = [];
      for (const doc of SAMPLE_DOCUMENTS) {
        // Sequential on purpose: these hit the same per-user rate limit as
        // any other POST /documents call, and there's no UX reason to race
        // three creates against each other for a one-off dev convenience.
        created.push(await apiFetch("/documents", DocumentDetailSchema, { method: "POST", body: doc }));
      }
      return created;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentsKeys.all });
    },
  });
}
