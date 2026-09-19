import { AiInfoResponseSchema } from "@kb/shared";

import { Badge } from "@/components/ui/badge";

/**
 * "Chat: groq/llama-3.3-70b · Embeddings: openai/text-embedding-3-small" —
 * the brief calls this out by name: "It makes swapping visible in the
 * Loom." Rendered server-side (this is an `async` Server Component, not a
 * TanStack Query hook) because GET /meta/ai is `@Public()` and needs no
 * Supabase session, so there's nothing to gain from a client-side
 * fetch-after-mount here — it can just be part of the layout's initial
 * HTML. A fetch failure (API down) degrades to nothing rendered rather
 * than breaking the whole app shell.
 */
export async function ProviderBadge() {
  const info = await fetchAiInfo();
  if (!info) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <Badge variant="secondary" className="font-normal">
        Chat: {info.chat.provider}/{info.chat.model}
      </Badge>
      <Badge variant="secondary" className="font-normal">
        Embeddings: {info.embedding.provider}/{info.embedding.model}
      </Badge>
    </div>
  );
}

async function fetchAiInfo() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/meta/ai`, {
      // Provider config barely ever changes at runtime; a short revalidate
      // window keeps the badge cheap without going fully static (a env
      // swap + api restart should show up within a minute, not require a
      // web redeploy).
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const parsed = AiInfoResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
