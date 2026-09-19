"use client";

import { useState, type KeyboardEvent } from "react";
import { XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/** Enter or comma adds a chip; Backspace on an empty field pops the last one. Values are lowercased/deduped to match @kb/shared's tag schema, so what's shown always matches what the server will store. */
export function TagInput({ value, onChange, id }: { value: string[]; onChange: (tags: string[]) => void; id?: string }) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 font-normal">
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="rounded-full hover:bg-black/10 dark:hover:bg-white/10"
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <Input
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? "Add tags…" : ""}
        className="h-6 flex-1 border-0 p-0 shadow-none focus-visible:ring-0"
      />
    </div>
  );
}
