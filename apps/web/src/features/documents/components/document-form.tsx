"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { MessageSquareIcon, Trash2Icon } from "lucide-react";
import type { DocumentDetail } from "@kb/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { IndexStatusBadge } from "@/features/documents/components/index-status-badge";
import { TagInput } from "@/features/documents/components/tag-input";
import { mergeServerSnapshot } from "@/features/documents/draft-merge.mjs";
import { useDeleteDocument } from "@/features/documents/hooks/use-delete-document";
import { useReindexDocument } from "@/features/documents/hooks/use-reindex-document";
import { useSaveDocument } from "@/features/documents/hooks/use-save-document";
import { ApiError } from "@/lib/api/error";

interface DraftState {
  title: string;
  content: string;
  tags: string[];
}

function snapshotOf(doc: DocumentDetail | undefined): DraftState {
  return { title: doc?.title ?? "", content: doc?.content ?? "", tags: doc?.tags ?? [] };
}

/**
 * Shared by /documents/new (no `document`) and /documents/[id] (`document`
 * + `documentId` set). ⌘S/Ctrl+S saves; a native `beforeunload` handler
 * warns on tab close/refresh/typed-URL navigation while dirty — Next.js's
 * App Router has no stable client-side navigation-blocking API yet (see
 * docs/DECISIONS.md Phase 6), so an in-app Link click isn't intercepted;
 * that's a known, documented gap rather than a silent one.
 *
 * `highlightRange` comes from the /documents/:id?highlight=start-end deep
 * link a chat citation's "Open document" link produces (see
 * features/chat/components/citation-badge.tsx): on mount it switches to
 * the Write tab (already the default) and selects that character range in
 * the textarea, which both scrolls it into view and highlights it using
 * the browser's native text-selection rendering — no separate rich-text
 * highlighter needed for what's otherwise a plain <textarea>.
 */
export function DocumentForm({
  documentId,
  document,
  highlightRange,
}: {
  documentId?: string;
  document?: DocumentDetail;
  highlightRange?: [number, number];
}) {
  const router = useRouter();
  const [original, setOriginal] = useState<DraftState>(() => snapshotOf(document));
  const [draft, setDraft] = useState<DraftState>(() => snapshotOf(document));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  const save = useSaveDocument();
  const deleteDoc = useDeleteDocument();
  const reindex = useReindexDocument();

  // Keep the draft's baseline in sync when the server pushes a newer
  // document (e.g. a background poll picking up a finished index) — but
  // only while the form isn't dirty, so a background refresh never
  // clobbers text the user is mid-edit on. Adjusting state during render
  // (rather than in a useEffect) per
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders —
  // this is the "resetting state when a prop changes" pattern React's own
  // docs recommend over an effect+setState, and it's what the
  // react-hooks/set-state-in-effect lint rule is steering toward.
  const [lastSyncedDocument, setLastSyncedDocument] = useState(document);
  if (document !== lastSyncedDocument && !dirty) {
    setLastSyncedDocument(document);
    setOriginal(snapshotOf(document));
    setDraft(snapshotOf(document));
  }

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirty) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(false);

  useEffect(() => {
    if (!highlightRange || !document) return;
    const [start, end] = highlightRange;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const clampedStart = Math.max(0, Math.min(start, textarea.value.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, textarea.value.length));
    textarea.focus();
    textarea.setSelectionRange(clampedStart, clampedEnd);
    // scrollIntoView first so the textarea itself is visible before the
    // browser scrolls its *internal* content to the selection.
    textarea.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.id, highlightRange?.[0], highlightRange?.[1]]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void handleSave();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (savingRef.current) return;
    const current = draftRef.current;
    if (!current.title.trim()) {
      toast.error("Title is required.");
      return;
    }
    savingRef.current = true;
    try {
      const saved = await save.mutateAsync({ id: documentId, values: current });
      const savedSnapshot = snapshotOf(saved);
      setOriginal(savedSnapshot);
      // Not `setDraft(savedSnapshot)`: the request was in flight for a real
      // round trip, and the user may have kept typing during it. Only a
      // field that's still exactly what was sent adopts the server's value
      // — anything the user changed since is kept, and stays correctly
      // flagged dirty against the new `original` baseline above. See
      // docs/DECISIONS.md Phase 6, D6.16.
      setDraft((live) => mergeServerSnapshot(current, savedSnapshot, live));
      toast.success("Document saved.");
      if (!documentId) {
        router.replace(`/documents/${saved.id}`);
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to save document.");
    } finally {
      savingRef.current = false;
    }
  }

  async function handleDelete() {
    if (!documentId) return;
    try {
      await deleteDoc.mutateAsync(documentId);
      toast.success("Document deleted.");
      router.push("/documents");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to delete document.");
    }
  }

  async function handleRetry() {
    if (!documentId) return;
    // Captured now, not read as `dirty` after the await below: `dirty` is
    // a plain render-time value, and this closure would otherwise use
    // whatever it was AT THE MOMENT handleRetry was called — stale by the
    // time reindex.mutateAsync resolves. If the user started typing only
    // after clicking Retry (dirty was false at call time, so the stale
    // check would wrongly treat the field as untouched), the old
    // `dirty ? prev.content : saved.content` silently overwrote that fresh
    // edit with reindexing's own (correct, but older) content. See
    // docs/DECISIONS.md Phase 6, D6.16.
    const sent = draftRef.current;
    try {
      const saved = await reindex.mutateAsync(documentId);
      const savedSnapshot = snapshotOf(saved);
      setOriginal(savedSnapshot);
      setDraft((live) => mergeServerSnapshot(sent, savedSnapshot, live));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to retry indexing.");
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="doc-title">Title</Label>
          <Input
            id="doc-title"
            value={draft.title}
            onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
            placeholder="Untitled document"
            className="text-lg font-medium"
          />
        </div>
        {document ? (
          <div className="pt-7">
            <IndexStatusBadge
              status={document.indexStatus}
              chunkCount={document.chunkCount}
              onRetry={handleRetry}
              retrying={reindex.isPending}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="doc-tags">Tags</Label>
        <TagInput id="doc-tags" value={draft.tags} onChange={(tags) => setDraft((prev) => ({ ...prev, tags }))} />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Content</Label>
        <Tabs defaultValue="write">
          <TabsList>
            <TabsTrigger value="write">Write</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
          <TabsContent value="write">
            <Textarea
              ref={textareaRef}
              value={draft.content}
              onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
              placeholder="Write in Markdown…"
              className="min-h-96 font-mono text-sm"
            />
          </TabsContent>
          <TabsContent value="preview">
            <div className="prose prose-sm dark:prose-invert min-h-96 max-w-none rounded-md border p-3">
              {draft.content.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.content}</ReactMarkdown>
              ) : (
                <p className="text-muted-foreground">Nothing to preview yet.</p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button onClick={() => void handleSave()} disabled={save.isPending || !dirty}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {dirty ? <span className="text-muted-foreground text-xs">Unsaved changes</span> : null}
        </div>

        {documentId ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link href={`/chat?documentIds=${documentId}`}>
                <MessageSquareIcon className="size-4" />
                Ask about this doc
              </Link>
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="text-destructive hover:text-destructive">
                  <Trash2Icon className="size-4" />
                  Delete
                </Button>
              </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this document?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes &ldquo;{document?.title ?? "this document"}&rdquo; and its indexed chunks. This can&apos;t be
                  undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleDelete()} className="bg-destructive text-white hover:bg-destructive/90">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
      </div>
    </div>
  );
}
