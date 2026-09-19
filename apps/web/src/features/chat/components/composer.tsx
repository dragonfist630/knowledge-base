"use client";

import { useState, type KeyboardEvent } from "react";
import { SendIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ALL_SCOPE, ScopeSelector, type ChatScope } from "@/features/chat/components/scope-selector";

export interface ComposerSubmitInput {
  message: string;
  documentIds?: string[];
  tags?: string[];
}

/** Enter sends, Shift+Enter adds a newline — the brief's own spec. */
export function Composer({
  onSend,
  isStreaming,
  onStop,
  initialScope,
}: {
  onSend: (input: ComposerSubmitInput) => void;
  isStreaming: boolean;
  onStop: () => void;
  initialScope?: ChatScope;
}) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<ChatScope>(initialScope ?? ALL_SCOPE);

  function submit() {
    const message = text.trim();
    if (!message || isStreaming) return;
    onSend({
      message,
      documentIds: scope.mode === "documents" ? scope.documentIds : undefined,
      tags: scope.mode === "tags" ? scope.tags : undefined,
    });
    setText("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t p-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-center justify-between">
          <ScopeSelector scope={scope} onChange={setScope} />
          {isStreaming ? (
            <Button type="button" variant="outline" size="sm" onClick={onStop} className="gap-1.5">
              <SquareIcon className="size-3.5" />
              Stop
            </Button>
          ) : null}
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your documents…"
            className="min-h-11 flex-1 resize-none"
            rows={1}
          />
          <Button type="button" size="icon" onClick={submit} disabled={!text.trim() || isStreaming} aria-label="Send message">
            <SendIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
