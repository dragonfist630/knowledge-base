"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConversations } from "@/features/chat/hooks/use-conversations";
import { useDeleteConversation, useRenameConversation } from "@/features/chat/hooks/use-conversation-mutations";
import { ApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils";

export function ConversationList({ activeId }: { activeId?: string }) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations();
  const conversations = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | undefined>();
  const [draftTitle, setDraftTitle] = useState("");

  const rename = useRenameConversation();
  const remove = useDeleteConversation();

  function startEditing(id: string, title: string) {
    setEditingId(id);
    setDraftTitle(title);
  }

  async function commitRename(id: string) {
    const title = draftTitle.trim();
    setEditingId(undefined);
    if (!title) return;
    try {
      await rename.mutateAsync({ id, title });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to rename conversation.");
    }
  }

  async function handleDelete(id: string) {
    try {
      await remove.mutateAsync(id);
      if (id === activeId) router.push("/chat");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to delete conversation.");
    }
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col gap-2 border-r p-3">
      <Button asChild variant="outline" size="sm" className="justify-start gap-1.5">
        <Link href="/chat">
          <PlusIcon className="size-4" />
          New conversation
        </Link>
      </Button>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-8 w-full" />)
        ) : conversations.length === 0 ? (
          <p className="text-muted-foreground px-2 py-4 text-center text-xs">No conversations yet.</p>
        ) : (
          conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
                conversation.id === activeId ? "bg-secondary" : "hover:bg-accent",
              )}
            >
              {editingId === conversation.id ? (
                <>
                  <Input
                    autoFocus
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void commitRename(conversation.id);
                      if (event.key === "Escape") setEditingId(undefined);
                    }}
                    className="h-7 flex-1"
                  />
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => void commitRename(conversation.id)}>
                    <CheckIcon className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => setEditingId(undefined)}>
                    <XIcon className="size-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <Link href={`/chat/${conversation.id}`} className="min-w-0 flex-1 truncate">
                    {conversation.title || "New conversation"}
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                        aria-label="Conversation actions"
                      >
                        <MoreHorizontalIcon className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => startEditing(conversation.id, conversation.title)}>
                        <PencilIcon className="size-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => void handleDelete(conversation.id)}
                      >
                        <Trash2Icon className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          ))
        )}
        {hasNextPage ? (
          <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
